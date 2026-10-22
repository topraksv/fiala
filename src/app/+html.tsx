import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

import { contentSecurityPolicy } from "../domain/web-security";
import { tr } from "../i18n/tr";
import { focusRingCss } from "../ui/focus-ring";
import { APPEARANCE_KEYS, DEFAULT_PALETTE_ID, PALETTES } from "../ui/theme";

const GROUNDS = Object.fromEntries(
  Object.entries(PALETTES).map(([id, { light, dark }]) => [id, [light.background, dark.background]]),
);

// Runs before the bundle in every browser, so it is ES5 and swallows its own
// errors. Storage has a try of its own: a browser that blocks site data throws
// on reading `localStorage`, and should still get the system's scheme.
const PAINT_GROUND = [
  `try{var g=${JSON.stringify(GROUNDS)},p,t;`,
  `try{p=localStorage.getItem(${JSON.stringify(APPEARANCE_KEYS.palette)});t=localStorage.getItem(${JSON.stringify(APPEARANCE_KEYS.theme)})}catch(e){}`,
  `var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches),r=document.documentElement;`,
  `r.style.background=(Object.prototype.hasOwnProperty.call(g,p)?g[p]:g[${JSON.stringify(DEFAULT_PALETTE_ID)}])[d?1:0];`,
  `r.style.colorScheme=d?"dark":"light"}catch(e){}`,
].join("");

// Only under the deployed base: the dev server serves the root, where a worker scoped to
// `/fiala/` would never control a page.
const REGISTER_WORKER = [
  `if("serviceWorker" in navigator&&location.pathname.indexOf("/fiala/")===0){`,
  `addEventListener("load",function(){navigator.serviceWorker.register("/fiala/sw.js",{scope:"/fiala/"}).catch(function(){})})}`,
].join("");

const { light, dark } = PALETTES[DEFAULT_PALETTE_ID];

const SITE_URL = "https://topraksv.github.io/fiala/";

/** One static document for every visitor: the script paints the stored ground before the bundle
 *  loads. `viewport-fit=cover` gives iOS Safari real safe-area insets. */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="tr">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* A token in the address must not ride the page's asset requests as a referrer before
            the app takes it from there. */}
        <meta name="referrer" content="no-referrer" />
        <meta httpEquiv="Content-Security-Policy" content={contentSecurityPolicy(process.env.EXPO_PUBLIC_SUPABASE_URL)} />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <title>{tr.meta.title}</title>
        <meta name="description" content={tr.meta.social} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Fiala" />
        <meta property="og:locale" content="tr_TR" />
        <meta property="og:title" content={tr.meta.title} />
        <meta property="og:description" content={tr.meta.social} />
        <meta property="og:url" content={SITE_URL} />
        <meta name="twitter:card" content="summary" />
        {/* Installing to the home screen (SPEC 6.1). The browser's chrome
            takes the default palette's ground per scheme on the first paint;
            the root layout then writes the chosen palette's over both. */}
        <link rel="manifest" href="/fiala/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/fiala/icons/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Fiala" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={light.background} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={dark.background} />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: focusRingCss(light.focus) }} />
        <script dangerouslySetInnerHTML={{ __html: PAINT_GROUND }} />
        <script dangerouslySetInnerHTML={{ __html: REGISTER_WORKER }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
