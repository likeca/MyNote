/**
 * Code block colouring with Shiki: VS Code's TextMate grammars, so code is coloured as VS Code colours
 * it (in shell: commands, options, operators, variables and keywords). A language's grammar loads the
 * first time a block uses it, as its own chunk, and blocks are coloured once it has. The colours are
 * the app's `--tok-*` variables (index.css), so every palette, light and dark, themes code too.
 */
import type { Plugin } from "@tiptap/pm/state";
import { Decoration } from "@tiptap/pm/view";
import { createHighlightPlugin, type Parser } from "prosemirror-highlight";
import { createHighlighterCore, type HighlighterCore, type LanguageInput, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const shellscript = () => import("@shikijs/langs/shellscript");
const html = () => import("@shikijs/langs/html");
const javascript = () => import("@shikijs/langs/javascript");
const typescript = () => import("@shikijs/langs/typescript");
const python = () => import("@shikijs/langs/python");
const yaml = () => import("@shikijs/langs/yaml");

/** The Shiki grammar for each block language (the menu's ids and what people type after ```). */
const GRAMMARS: Record<string, [name: string, load: () => LanguageInput]> = {
  // Shell blocks run with bash or zsh (script.rs); the grammar is the same.
  bash: ["shellscript", shellscript],
  "bash-profile": ["shellscript", shellscript],
  sh: ["shellscript", shellscript],
  shell: ["shellscript", shellscript],
  zsh: ["shellscript", shellscript],
  c: ["c", () => import("@shikijs/langs/c")],
  cpp: ["cpp", () => import("@shikijs/langs/cpp")],
  csharp: ["csharp", () => import("@shikijs/langs/csharp")],
  css: ["css", () => import("@shikijs/langs/css")],
  diff: ["diff", () => import("@shikijs/langs/diff")],
  go: ["go", () => import("@shikijs/langs/go")],
  graphql: ["graphql", () => import("@shikijs/langs/graphql")],
  // "HTML / XML" in the menu: HTML's grammar also reads XML.
  xml: ["html", html],
  html: ["html", html],
  ini: ["ini", () => import("@shikijs/langs/ini")],
  toml: ["toml", () => import("@shikijs/langs/toml")],
  java: ["java", () => import("@shikijs/langs/java")],
  javascript: ["javascript", javascript],
  js: ["javascript", javascript],
  jsx: ["jsx", () => import("@shikijs/langs/jsx")],
  json: ["json", () => import("@shikijs/langs/json")],
  kotlin: ["kotlin", () => import("@shikijs/langs/kotlin")],
  lua: ["lua", () => import("@shikijs/langs/lua")],
  makefile: ["make", () => import("@shikijs/langs/make")],
  markdown: ["markdown", () => import("@shikijs/langs/markdown")],
  objectivec: ["objective-c", () => import("@shikijs/langs/objective-c")],
  php: ["php", () => import("@shikijs/langs/php")],
  python: ["python", python],
  py: ["python", python],
  r: ["r", () => import("@shikijs/langs/r")],
  ruby: ["ruby", () => import("@shikijs/langs/ruby")],
  rust: ["rust", () => import("@shikijs/langs/rust")],
  rs: ["rust", () => import("@shikijs/langs/rust")],
  scss: ["scss", () => import("@shikijs/langs/scss")],
  sql: ["sql", () => import("@shikijs/langs/sql")],
  swift: ["swift", () => import("@shikijs/langs/swift")],
  typescript: ["typescript", typescript],
  ts: ["typescript", typescript],
  tsx: ["tsx", () => import("@shikijs/langs/tsx")],
  yaml: ["yaml", yaml],
  yml: ["yaml", yaml],
};

const tok = (name: string) => `var(--tok-${name})`;

/** VS Code's token scopes, coloured with the app's code colours. */
const THEME: ThemeRegistration = {
  name: "mynote",
  type: "light",
  fg: "var(--ink)",
  bg: "transparent",
  settings: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: tok("comment"), fontStyle: "italic" } },
    { scope: ["keyword", "storage", "constant.language"], settings: { foreground: tok("keyword") } },
    { scope: ["keyword.operator", "punctuation.separator.statement"], settings: { foreground: tok("operator") } },
    { scope: ["string", "punctuation.definition.string", "markup.inserted"], settings: { foreground: tok("string") } },
    // A shell command's plain arguments are words, not strings.
    { scope: ["string.unquoted.argument"], settings: { foreground: "var(--ink)" } },
    { scope: ["constant.numeric", "constant.character", "constant.other.color"], settings: { foreground: tok("number") } },
    { scope: ["entity.name.function", "entity.name.command", "support.function", "meta.function-call.generic"], settings: { foreground: tok("function") } },
    { scope: ["support.function.builtin", "entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"], settings: { foreground: tok("builtin") } },
    {
      scope: ["variable.parameter", "variable.language", "variable.other.normal", "variable.other.special", "variable.other.positional", "variable.other.bracket", "variable.other.assignment", "punctuation.definition.variable", "entity.name.tag"],
      settings: { foreground: tok("variable") },
    },
    { scope: ["constant.other.option", "entity.other.attribute-name", "support.type.property-name", "meta.object-literal.key"], settings: { foreground: tok("attr") } },
    { scope: ["meta.preprocessor", "punctuation.definition.tag", "meta.diff.header", "meta.diff.range"], settings: { foreground: tok("meta") } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: tok("title"), fontStyle: "bold" } },
    { scope: ["markup.deleted"], settings: { foreground: "var(--c-red-text)" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
  ],
};

let highlighter: HighlighterCore | undefined;
let starting: Promise<void> | undefined;
const loading = new Map<string, Promise<void>>();
/** Grammars that failed to load: those blocks stay plain instead of retrying on every edit. */
const unavailable = new Set<string>();

/** Decorations for a block, or a promise while Shiki or the block's grammar is still loading. */
const parse: Parser = (options) => {
  const grammar = GRAMMARS[options.language?.toLowerCase() ?? ""];
  if (!grammar || unavailable.has(grammar[0])) return [];
  if (!highlighter) {
    starting ??= createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() }).then(
      (h) => void (highlighter = h),
      () => void Object.values(GRAMMARS).forEach(([name]) => unavailable.add(name)),
    );
    return starting;
  }
  const [name, load] = grammar;
  if (!highlighter.getLoadedLanguages().includes(name)) {
    if (!loading.has(name)) loading.set(name, highlighter.loadLanguage(load()).catch(() => void unavailable.add(name)));
    return loading.get(name)!;
  }
  return decorate(highlighter, options.content, name, options.pos);
};

/** vscode-textmate's FontStyle bits (unset is -1). */
const ITALIC = 1;
const BOLD = 2;

/** One inline decoration per coloured or styled token; plain text needs none. */
function decorate(highlighter: HighlighterCore, content: string, language: string, pos: number): Decoration[] {
  const { tokens } = highlighter.codeToTokens(content, { lang: language, theme: THEME.name! });
  const decorations: Decoration[] = [];
  let from = pos + 1;
  for (const line of tokens) {
    for (const token of line) {
      const to = from + token.content.length;
      const font = token.fontStyle !== undefined && token.fontStyle > 0 ? token.fontStyle : 0;
      const style = [
        token.color && token.color !== THEME.fg ? `color: ${token.color}` : "",
        font & ITALIC ? "font-style: italic" : "",
        font & BOLD ? "font-weight: 600" : "",
      ]
        .filter(Boolean)
        .join("; ");
      if (style) decorations.push(Decoration.inline(from, to, { style }));
      from = to;
    }
    from += 1; // the newline between lines
  }
  return decorations;
}

/** Colours `codeBlock` nodes by their `language` attribute. */
export const codeHighlight = (): Plugin => createHighlightPlugin({ parser: parse, nodeTypes: ["codeBlock"] });
