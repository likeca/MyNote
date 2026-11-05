import logo from "../assets/logo.png";

/** The app's logo: a light blue block with an "N" (brand/block-icon.svg, cropped to the block). */
export function Logo({ className = "" }: { className?: string }) {
  return <img src={logo} alt="" aria-hidden draggable={false} className={`object-contain ${className}`} />;
}
