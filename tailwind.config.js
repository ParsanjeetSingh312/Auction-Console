/**
 * Tailwind theme, transcribed from the design tokens in auction-console.html.
 *
 * The prototype is a light "paper" console — a cool green-grey stock taken from
 * the auction sheet's mint header, teal structural accent, and a three-family
 * type system (condensed display numerals / plain body / mono utility labels).
 * Keeping the same names as the prototype's CSS variables makes the two files
 * easy to diff by eye.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: [
    "./index.html",
    "./*.tsx",
    "./components/**/*.{ts,tsx}",
    "./console/**/*.{ts,tsx}",
    // Phase 4 adds routed pages and the socket hook. Tailwind only emits a
    // class it has seen in a scanned file, so a directory missing from this
    // list produces a page with no styles and no error to explain it.
    "./pages/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // --- enterprise white theme ---
        surface: {
          DEFAULT: "#F8F9FA", // the page
          sunken: "#F4F6F8",  // wells and inset panels
          card: "#FFFFFF",    // every raised panel
        },
        line: {
          DEFAULT: "#E8ECF1", // hairline borders
          soft: "#F1F4F8",
        },
        slate: {
          ink: "#0F172A",     // headings
          body: "#334155",    // body copy
          muted: "#64748B",   // labels
          faint: "#94A3B8",   // captions
        },
        // IPL franchise colours, used only as accents - a dot, a left border,
        // a figure. Never as a fill, which would turn a dashboard into a kit.
        ipl: {
          mum: "#004BA0",
          che: "#F9CD05",
          rcb: "#D5152D",
          kkr: "#3A225D",
          dc: "#17479E",
          pbks: "#D71920",
          rr: "#EA1A85",
          srh: "#F26522",
          lsg: "#0057E2",
          gt: "#1B2133",
        },

        paper: "#F2F5F1",
        card: "#FFFFFF",
        ink: { DEFAULT: "#111614", soft: "#3C453F" },
        muted: "#6D7873",
        rule: { DEFAULT: "#D9DED7", soft: "#EBEEE9" },
        teal: { DEFAULT: "#0B6E5B", ink: "#075244", tint: "#E3EFEB" },
        sold: { DEFAULT: "#1E6B47", tint: "#E6F1EA" },
        unsold: { DEFAULT: "#A2382C", tint: "#F7E7E4" },
        live: { DEFAULT: "#9C6414", tint: "#FBEEDA" },
        // Role glyph fills, carried over from the source sheet.
        role: {
          bat: "#3C6FA8",
          bowl: "#A65432",
          ar: "#5D8C33",
          wk: "#7A5AA8",
        },
      },
      /**
       * The enterprise white theme, layered over the original paper tokens
       * rather than replacing them - the Phase 2 console still reads against
       * `paper`/`card`, so both vocabularies stay valid.
       */
      backgroundImage: {
        // A 1px dot on a 20px grid: enough texture to stop a large white field
        // reading as an unpainted div, faint enough to disappear behind content.
        dots: "radial-gradient(circle at 1px 1px, rgba(15,23,42,.055) 1px, transparent 0)",
      },
      backgroundSize: {
        dots: "20px 20px",
      },
      fontFamily: {
        // Figures: bids, purses, percentages.
        num: ["Rajdhani", "Teko", "Arial Narrow", "sans-serif"],
        // Names and headings.
        head: ["Outfit", "Montserrat", "Segoe UI", "system-ui", "sans-serif"],
        // Tables, labels, dense UI.
        ui: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        display: [
          "Arial Narrow",
          "Roboto Condensed",
          "Helvetica Neue Condensed",
          "Liberation Sans Narrow",
          "Impact",
          "sans-serif",
        ],
        body: [
          "Segoe UI",
          "system-ui",
          "-apple-system",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "Consolas",
          "SF Mono",
          "ui-monospace",
          "DejaVu Sans Mono",
          "Liberation Mono",
          "monospace",
        ],
      },
      fontSize: {
        eyebrow: ["9.5px", { lineHeight: "1.3", letterSpacing: "0.13em" }],
        micro: ["10px", { lineHeight: "1.35" }],
        tiny: ["11px", { lineHeight: "1.4" }],
        mini: ["11.5px", { lineHeight: "1.4" }],
        base: ["13.5px", { lineHeight: "1.45" }],
      },
      boxShadow: {
        card: "0 1px 2px rgba(17,22,20,.06), 0 8px 24px -18px rgba(17,22,20,.35)",
        // The enterprise shadow: diffused and almost colourless, so panels read
        // as lifted paper rather than as boxes with a drop shadow.
        soft: "0 4px 20px rgba(0,0,0,0.04)",
        "soft-lg": "0 8px 32px rgba(15,23,42,0.06)",
        chip: "0 1px 2px rgba(15,23,42,.04), 0 2px 8px rgba(15,23,42,.04)",
      },
      spacing: {
        rail: "6px",
      },
    },
  },
  plugins: [],
};
