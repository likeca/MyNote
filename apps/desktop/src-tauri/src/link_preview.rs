//! A web page's title and icon, for link mentions: a URL pasted into a page shows as the site's icon
//! and the page's title, as in Notion. The webview can't read other sites' pages (CORS), so they're
//! fetched here.

use base64::Engine;
use scraper::{Html, Selector};
use serde::Serialize;
use std::sync::LazyLock;
use std::time::Duration;
use ureq::ResponseExt;

use crate::importer::remote_images::image_ext;

/// Enough of a page for its `<head>`.
const MAX_PAGE: u64 = 1 << 20;
const MAX_ICON: u64 = 256 << 10;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct LinkPreview {
    /// The page's `og:title` (else its `<title>`), whitespace collapsed.
    title: Option<String>,
    /// The site's icon as a `data:` URL.
    icon: Option<String>,
    /// Who it belongs to, shown after the title: a GitHub page's owner's avatar, as a `data:` URL.
    avatar: Option<String>,
}

static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        // Some sites answer unknown clients with an error page; this one gets the real page.
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")
        .http_status_as_error(true)
        .build()
        .into()
});

#[tauri::command]
pub async fn link_preview(url: String) -> Result<LinkPreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview(&url)).await.map_err(|e| e.to_string())
}

fn preview(url: &str) -> LinkPreview {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return LinkPreview::default();
    }
    let page = AGENT.get(url).call().ok().and_then(|mut res| {
        let base = res.get_uri().to_string();
        let html = res.body_mut().with_config().limit(MAX_PAGE).read_to_string().ok()?;
        Some((base, html))
    });
    let (title, icon_href) = page.as_ref().map(|(base, html)| read_head(html, base)).unwrap_or_default();
    let base = page.as_ref().map_or(url, |(b, _)| b.as_str());
    let fallback = origin(base).map(|o| format!("{o}/favicon.ico"));
    let icon = icon_href.into_iter().chain(fallback).find_map(|u| fetch_image(&u));
    // GitHub, as Notion shows it: a repository by its name ("helm-charts", not "GitHub - …"), and
    // its owner's avatar after the title.
    let gh = github(base).or_else(|| github(url));
    let title = gh.as_ref().and_then(|g| g.repo_page.clone()).or(title);
    let avatar = gh.and_then(|g| fetch_image(&format!("https://github.com/{}.png?size=64", g.owner)));
    LinkPreview { title, icon, avatar }
}

/// The page's title and the address of its icon (resolved against `base`), from its HTML.
fn read_head(html: &str, base: &str) -> (Option<String>, Option<String>) {
    let doc = Html::parse_document(html);
    let first = |css: &str, attr: Option<&str>| {
        let sel = Selector::parse(css).ok()?;
        doc.select(&sel)
            .map(|el| attr.map_or_else(|| el.text().collect::<String>(), |a| el.value().attr(a).unwrap_or("").to_string()))
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .find(|s| !s.is_empty())
    };
    // The title a page gives for sharing (YouTube's is the video's name, without " - YouTube"), as
    // Notion shows; else its `<title>`.
    let title = first(r#"meta[property="og:title"]"#, Some("content")).or_else(|| first("head title, title", None));
    // `icon` and `shortcut icon` first, then Apple's touch icon (bigger, but most sites have one).
    let icon = first(r#"link[rel~="icon"]"#, Some("href"))
        .or_else(|| first(r#"link[rel="apple-touch-icon"]"#, Some("href")))
        .and_then(|href| resolve(base, &href));
    (title.map(|t| t.chars().take(200).collect()), icon)
}

/// `scheme://host[:port]` of an http(s) URL.
fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty()).then(|| format!("{scheme}://{host}"))
}

/// `href` as an absolute URL, read from a page at `base`.
fn resolve(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.starts_with("http://") || href.starts_with("https://") {
        return Some(href.to_string());
    }
    if href.starts_with("data:") {
        return None;
    }
    if let Some(rest) = href.strip_prefix("//") {
        return Some(format!("{}://{rest}", base.split_once("://")?.0));
    }
    let origin = origin(base)?;
    if href.starts_with('/') {
        return Some(format!("{origin}{href}"));
    }
    // Relative to the page's folder.
    let path = &base[origin.len()..];
    let path = path.split(['?', '#']).next().unwrap_or("");
    let dir = &path[..path.rfind('/').map_or(0, |i| i + 1)];
    Some(format!("{origin}{}{href}", if dir.is_empty() { "/" } else { dir }))
}

/// What a github.com address points at: its owner (user or organisation) and, for a repository's
/// own page (`github.com/owner/repo`), the repository's name.
#[derive(Debug, PartialEq)]
struct GitHub {
    owner: String,
    repo_page: Option<String>,
}

/// Top-level github.com pages that aren't a user or organisation.
const GITHUB_PAGES: &[&str] = &[
    "about", "apps", "collections", "customer-stories", "enterprise", "explore", "features", "issues", "login", "marketplace", "new",
    "notifications", "orgs", "pricing", "pulls", "search", "security", "settings", "signup", "sponsors", "team", "topics", "trending",
];

fn github(url: &str) -> Option<GitHub> {
    let rest = url.split_once("://")?.1;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if !matches!(host.to_ascii_lowercase().as_str(), "github.com" | "www.github.com") {
        return None;
    }
    let parts: Vec<&str> = path.split(['?', '#']).next().unwrap_or("").split('/').filter(|p| !p.is_empty()).collect();
    let owner = *parts.first()?;
    if GITHUB_PAGES.contains(&owner.to_ascii_lowercase().as_str()) {
        return None;
    }
    let repo_page = (parts.len() == 2).then(|| parts[1].trim_end_matches(".git").to_string());
    Some(GitHub { owner: owner.to_string(), repo_page })
}

/// The image at `url` (an icon, an avatar) as a `data:` URL, when it is one (judged by its bytes).
fn fetch_image(url: &str) -> Option<String> {
    let mut res = AGENT.get(url).call().ok()?;
    let bytes = res.body_mut().with_config().limit(MAX_ICON).read_to_vec().ok()?;
    let mime = match image_ext(&bytes)? {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_title_and_icon_from_a_pages_head() {
        let html = r#"<html><head><meta property="og:title" content="  Example &amp; Co "><title>
          Example — Home </title><link rel="apple-touch-icon" href="/touch.png"><link rel="shortcut icon" href="img/fav.ico"></head></html>"#;
        let (title, icon) = read_head(html, "https://example.com/docs/page?x=1");
        assert_eq!(title.as_deref(), Some("Example & Co"), "the page's own title for sharing first, as Notion shows");
        assert_eq!(icon.as_deref(), Some("https://example.com/docs/img/fav.ico"));
        // No og:title: the <title>, whitespace collapsed. No icon link: none (the caller tries /favicon.ico).
        let (title, icon) = read_head("<title>\n  Only   the title </title>", "https://example.com");
        assert_eq!((title.as_deref(), icon), (Some("Only the title"), None));
    }

    #[test]
    fn resolves_icon_addresses_against_the_page() {
        let base = "https://sub.example.com:8080/a/b.html";
        assert_eq!(resolve(base, "/i.png").as_deref(), Some("https://sub.example.com:8080/i.png"));
        assert_eq!(resolve(base, "//cdn.example.com/i.png").as_deref(), Some("https://cdn.example.com/i.png"));
        assert_eq!(resolve(base, "i.png").as_deref(), Some("https://sub.example.com:8080/a/i.png"));
        assert_eq!(resolve("https://example.com", "i.png").as_deref(), Some("https://example.com/i.png"));
        assert_eq!(resolve(base, "data:image/png;base64,AA"), None);
        assert_eq!(origin("https://example.com?q=1").as_deref(), Some("https://example.com"));
    }

    #[test]
    fn only_web_addresses_are_fetched() {
        assert_eq!(preview("file:///etc/passwd"), LinkPreview::default());
        assert_eq!(preview("javascript:alert(1)"), LinkPreview::default());
    }

    #[test]
    fn knows_github_owners_and_repository_pages() {
        let repo = github("https://github.com/prometheus-community/helm-charts").unwrap();
        assert_eq!(repo, GitHub { owner: "prometheus-community".into(), repo_page: Some("helm-charts".into()) });
        // An issue or a file: the owner (for the avatar), but the page keeps its own title.
        assert_eq!(github("https://www.github.com/tauri-apps/tauri/issues/12?x#y").unwrap().repo_page, None);
        assert_eq!(github("https://github.com/torvalds").unwrap().owner, "torvalds");
        assert_eq!(github("https://github.com/pulls"), None, "GitHub's own pages have no owner");
        assert_eq!(github("https://gitlab.com/a/b"), None);
    }
}
