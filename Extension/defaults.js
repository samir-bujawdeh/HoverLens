'use strict';
// Default settings, shared by the content script, toolbar popup and settings page.
globalThis.HL_DEFAULTS = Object.freeze({
  enabled: true,
  delay: 200,            // ms to wait on hover before showing
  trigger: 'none',       // none | shift | ctrl | alt | meta  (hold this key to show)
  displayMode: 'auto',   // auto | side | center
  showBar: true,         // caption + info bar
  wheel: 'zoom',         // zoom | album | off
  backdrop: false,       // dim the page behind centered popups
  videoMuted: true,
  videoControls: false,
  minScaleUp: 1.1,       // don't pop up unless the full image is this much bigger than the thumbnail
  blacklist: [],         // hostnames where HoverLens is off
  userRules: ''          // custom "regex => replacement" lines
});
