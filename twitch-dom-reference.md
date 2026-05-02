# Twitch DOM Reference for Browser Extensions

A starter reference of Twitch DOM patterns that have been relatively stable, organized by page/feature. Treat this as a starting point to verify with DevTools, not as authoritative—Twitch updates frequently and runs A/B tests.

## General Patterns

Twitch is a React SPA. The root mounts at `#root`, with most app content inside `.root-scrollable` or `main.tw-root--theme-dark` (the theme class flips for light mode). Class names prefixed with `tw-` come from Twitch's internal design system (e.g., `tw-button`, `tw-link`). Hashed/minified classes change frequently—avoid them.

The most stable hooks are `data-a-target` and `data-test-selector` attributes, which Twitch uses internally for testing.

## Top Navigation

The top nav lives in a `<nav>` element, often with `data-a-target="top-nav"` or inside a header with `data-test-selector="top-nav__menu"`. Key children typically include:

- Logo link: `a[data-a-target="top-nav-logo"]`
- "Following" link: `a[data-a-target="following-link"]`
- "Browse" link: `a[data-a-target="browse-link"]`
- Search input: `input[data-a-target="tw-input"]` inside `[data-a-target="search-input"]`
- User menu: `[data-a-target="user-menu-toggle"]`
- Get Bits / Prime / notifications buttons live in a flex container on the right side

## Left Sidebar (Followed/Recommended Channels)

The collapsible left nav is one of the biggest distraction sources. Look for:

- Whole sidebar container: `nav[data-a-target="side-nav-bar"]` or `.side-nav`
- Followed channels section: `[aria-label="Followed Channels"]` or a heading with `data-a-target="side-nav-header-expanded"` containing "Followed"
- Recommended channels: similar pattern with "Recommended Channels" label
- Individual channel cards: `[data-a-target="side-nav-card"]` or `a.side-nav-card`
- "Show More" button: `[data-a-target="side-nav-show-more-toggle__button"]`

To hide the entire sidebar:

```css
nav[data-a-target="side-nav-bar"] { display: none !important; }
```

You may also need to adjust the main content's left margin.

## Homepage

The homepage is loaded with recommendations:

- Front-page carousel/featured stream: `.front-page-carousel` or `[data-a-target="front-page-carousel"]`
- "Live channels we think you'll like" shelf: look for `[data-a-target="shelf-title"]` and walk up to the shelf container
- Categories shelf: similar pattern, title contains "Categories" or "Popular Categories"
- Each shelf has a `.shelf` or `[data-test-selector="shelf"]` wrapper that you can target

A useful pattern: hide all shelves with `[data-test-selector="shelf"] { display: none !important; }` and let users opt specific ones back in.

## Channel/Stream Page

This is where most users spend time:

- Video player wrapper: `.video-player` or `[data-a-target="video-player"]`
- Player overlay: `[data-a-target="player-overlay-click-handler"]`
- Player controls: `[data-a-target="player-controls"]`
- Channel info bar (under player): `.channel-info-content` or a section containing `[data-a-target="stream-title"]` and `[data-a-target="stream-game-link"]`
- Streamer name/avatar: `[data-a-target="user-display-name"]` and `[data-a-target="user-avatar"]`
- Follow button: `[data-a-target="follow-button"]`
- Subscribe button: `[data-a-target="subscribe-button"]` or `[data-test-selector="subscribe-button"]`
- About section/panels: `.channel-panels-container` or `[data-test-selector="about-panel"]`
- Recommended streams below: typically inside a "Recommended channels" or "You might also like" shelf using the same shelf pattern as the homepage

## Chat

Chat is a common toggle target:

- Chat container: `.chat-shell` or `section[data-test-selector="chat-room-component-layout"]`
- Chat header: `[data-test-selector="chat-room-header-label"]`
- Message list: `.chat-scrollable-area__message-container` or `[data-test-selector="chat-scrollable-area__message-container"]`
- Chat input: `[data-a-target="chat-input"]` (a contenteditable div in modern Twitch, was a textarea historically)
- Send button: `[data-a-target="chat-send-button"]`
- Emote picker: `[data-a-target="emote-picker-button"]`
- Bits button: `[data-a-target="bits-button"]`
- Channel points claim button: inside `[data-test-selector="community-points-summary"]` ancestor with a button inside

To hide chat entirely:

```css
.chat-shell,
section[data-test-selector="chat-room-component-layout"] { display: none !important; }
```

## Directory/Browse Pages

- Category cards: `[data-a-target="tw-box-art-card-image"]` or wrappers with `[data-a-target="card-1"]`, `[data-a-target="card-2"]`, etc.
- Stream preview cards: `[data-a-target="preview-card-image-link"]` and `[data-a-target="preview-card-title-link"]`
- Tag filters: `[data-a-target="tag-search-input"]` and tag chips

## Promotional/Distracting Elements

These pop up across pages:

- Bits/Cheering prompts: `[data-test-selector="bits-tab"]`
- Prime Gaming prompts: search for elements with "prime" in `data-a-target`
- Drops campaigns banner: usually a banner with `[data-a-target="drops-campaign"]`-style selector
- "Squad Stream" or co-stream UI: `[data-a-target="multi-stream-player-layout"]`
- Stories (if rolled out for the user): newer feature, selectors vary—inspect when present

## Practical Starting CSS

A baseline you could ship and let users toggle:

```css
/* Hide left sidebar */
nav[data-a-target="side-nav-bar"] { display: none !important; }

/* Hide homepage carousel */
.front-page-carousel,
[data-a-target="front-page-carousel"] { display: none !important; }

/* Hide all content shelves (homepage recommendations) */
[data-test-selector="shelf"] { display: none !important; }

/* Hide recommended channels under stream */
.channel-recommendations,
[data-test-selector="recommended-channels"] { display: none !important; }

/* Hide chat */
.chat-shell { display: none !important; }

/* Hide bits/cheer UI */
[data-a-target="bits-button"],
[data-test-selector="bits-tab"] { display: none !important; }
```

## Tips for Robustness

Prefer attribute selectors (`[data-a-target="..."]`) over class selectors. When an attribute selector breaks, fall back to walking up from a stable inner element (e.g., a heading text) using `:has()` if you're targeting modern browsers—since Chrome supports it now, `section:has([data-a-target="stream-title"])` is viable. For elements with no stable hook, sometimes the only option is text-based matching with `:has()` plus content checks done in JS.

Build your extension so each rule is independent and toggleable—when Twitch breaks one, the rest keep working and users can report the broken one.

## Implementation Notes

- Use a content script that injects CSS via `chrome.scripting.insertCSS` or a `<style>` tag.
- For elements that load dynamically, CSS alone usually works since `display: none` applies regardless of when the element appears—you generally don't need a `MutationObserver` unless you're modifying rather than hiding.
- Provide toggles in your popup/options page that enable/disable each rule independently.
- Study Unhook and similar extensions (BetterTTV, FrankerFaceZ) on GitHub to see how they structure rules and options UI.
