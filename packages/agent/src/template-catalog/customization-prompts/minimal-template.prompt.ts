// Base prompt applied to every agent run (claude-code, codex, opencode, gemini,
// ...) that customizes a fork of directory-web-minimal-template. It pins the
// agent to a single compile-safe styling surface: apps/web/src/styles/theme.css.
// The user's request is appended to this prompt at runtime. The orchestrator
// enforces the surface independently of this prompt — see
// template-customization.service.ts (only theme.css is committed; out-of-scope
// edits are discarded; a theme.css with Tailwind directives is rejected).

export const MINIMAL_TEMPLATE_CUSTOMIZATION_PROMPT = `You are customizing a fork of \`directory-web-minimal-template\` — an Astro directory website (pnpm + Turborepo monorepo). Treat the user's request as a visual design brief, not a feature request.

# The only file you edit: apps/web/src/styles/theme.css

Do ALL of your work in \`apps/web/src/styles/theme.css\`. It is plain CSS, loaded after the framework styles, so anything you put there wins. This is the only file that ships — the orchestrator commits \`theme.css\` and discards every other change, so editing any other file is wasted effort and will be thrown away.

\`theme.css\` is processed by Tailwind. To keep the site compiling, it MUST stay plain CSS:
- Allowed: standard CSS only — custom-property overrides, selectors, \`@media\`, \`@supports\`, \`@font-face\`, \`@keyframes\`, \`@import url(...)\` for web fonts.
- Forbidden: \`@apply\`, \`@tailwind\`, \`@theme\`, \`@source\`, \`@reference\`, \`@plugin\`, \`@config\`, \`@utility\`, \`@variant\`, \`@custom-variant\`. A file containing any of these is rejected and your whole run is discarded.

Do not edit \`global.css\`, \`*.astro\`, \`*.ts\`, \`packages/**\`, \`.content/**\`, config, or deployment files. They either break the build or are discarded.

# How to restyle: design tokens + component hooks

1. Override design tokens. \`global.css\` defines these CSS custom properties; redefine any of them in \`theme.css\` under \`:root\` (light) and \`.dark\` (dark — the template toggles the \`.dark\` class on \`<html>\`):
   \`--background\`, \`--foreground\`, \`--card\`, \`--card-foreground\`, \`--popover\`, \`--popover-foreground\`, \`--primary\`, \`--primary-foreground\`, \`--secondary\`, \`--secondary-foreground\`, \`--muted\`, \`--muted-foreground\`, \`--accent\`, \`--accent-foreground\`, \`--destructive\`, \`--border\`, \`--input\`, \`--ring\`, \`--radius\`.

   Every component is already styled from the design tokens: the header and its search dialog, display settings and mobile menu, the listing browser (Classic and Modern Grid), the item page panels, the submit form and the multi-column footer all pick up your token overrides. Start with tokens; add component rules only for what tokens cannot express (shape, spacing, typography, layout details). The template's own component styles sit in a CSS cascade layer and \`theme.css\` is unlayered, so a plain selector wins without \`!important\`.

2. Style component hooks. Shared components and pages expose stable \`[data-component]\` / \`[data-part]\` attributes. Target them with plain CSS:
   - Chrome: \`[data-component="site-header"]\` (\`[data-part="search-trigger"]\`, \`[data-part="submit"]\`), \`[data-component="site-footer"]\`, \`[data-component="main"]\`, \`[data-component="skip-to-content"]\`, \`[data-component="back-to-top"]\`
   - Header extras: \`[data-component="search-dialog"]\`, \`[data-component="display-settings"]\`, \`[data-component="theme-toggle"]\`, \`[data-component="mobile-menu"]\`
   - Home/hero: \`[data-component="hero"]\` (\`[data-part="title"]\`, \`[data-part="subtitle"]\`, \`[data-part="cta"]\`), \`[data-component="category-nav"]\`, \`[data-component="item-listing"]\`, \`[data-component="featured-section"]\`, \`[data-component="category-cards"]\`, \`[data-component="submit-cta"]\`
   - Listing browser (homepage, \`/page/[n]\`, category and tag pages): \`[data-component="directory-browser"]\` with \`[data-part="sidebar"]\`, \`[data-part="category-chips"]\`, \`[data-part="toolbar"]\`, \`[data-part="search"]\`, \`[data-part="tag-filter"]\`, \`[data-part="sort"]\`, \`[data-part="view-toggle"]\`, \`[data-part="result-count"]\`, \`[data-part="active-filters"]\`, \`[data-part="results"]\`, \`[data-part="pagination"]\`
   - Cards/grid: \`[data-component="item-grid"]\`, \`[data-component="item-card"]\` (\`[data-part="icon"]\`, \`[data-part="name"]\`, \`[data-part="host"]\`, \`[data-part="featured-badge"]\`, \`[data-part="description"]\`, \`[data-part="category"]\`, \`[data-part="tag"]\`, \`[data-part="updated"]\`, \`[data-part="source-link"]\`); featured cards carry \`[data-featured]\`
   - Item page: \`[data-component="item-detail"]\` (\`[data-part="gallery"]\`, \`[data-part="info"]\`, \`[data-part="sticky-cta"]\`), \`[data-component="similar-items"]\`, \`[data-component="share-links"]\`
   - Taxonomy: \`[data-component="categories-page"]\`, \`[data-component="category-page"]\`, \`[data-component="tags-page"]\`, \`[data-component="tag-page"]\`
   - Collections/comparisons: \`[data-component="collections-page"]\`, \`[data-component="collection-page"]\`, \`[data-component="comparisons-page"]\`, \`[data-component="comparison-card"]\`
   - Forms and static pages: \`[data-component="submit-form"]\`, \`[data-component="legal-page"]\`
   - States: \`[data-component="empty-state"]\`, \`[data-component="not-found"]\`, \`[data-component="pagination"]\`

3. Respect visitor display preferences. Visitors choose how the site looks in the display settings, and the template writes each choice as an attribute on \`<html>\` before first paint:
   - Listing layout: \`html[data-layout="classic"]\` (sticky category sidebar) or \`html[data-layout="grid"]\` (Modern Grid: category chips and a tag menu above the results)
   - Card view: \`html[data-view="grid"]\`, \`html[data-view="list"]\` or \`html[data-view="compact"]\`
   - Page width: \`html[data-width="fixed"]\` or \`html[data-width="full"]\`
   - Pagination: \`html[data-pagination="standard"]\` or \`html[data-pagination="infinite"]\`
   Scope a rule to one choice with these selectors, for example \`html[data-view="list"] [data-component="item-card"]\`. Never hide the display settings or force one value: every combination must keep working and look designed.

# Coverage — design the whole site, not just the homepage

Your tokens and rules render across every route: homepage, paginated listings (\`/page/[n]\`), item detail, category/tag index + detail, collections, comparisons, the submit page, legal and other static pages, and 404. They also style the header's search dialog, display settings and mobile menu, both listing layouts and all three card views. Make it one coherent system: typography scale, spacing rhythm, page width, cards, buttons, links, badges, grids, focus states.

# Requirements

1. Cover both light and dark mode.
2. Keep contrast at WCAG AA or better in both themes.
3. Stay responsive: cards, grids, nav, headings, and long names must not overlap or overflow on mobile or desktop.
4. If the request is vague, make conservative, cohesive choices and stop. Avoid decorative excess.
5. No commits or PRs — the orchestrator commits and pushes.

The user's customization request follows below.
`;
