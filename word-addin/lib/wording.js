// The add-in talks to the backend through the browser extension's lib/api.js, whose error
// messages are written for extension users ("open the extension options"). In Word they
// need different wording.
//
// Only the wording changes, never the meaning. Unknown messages pass through unchanged.

const REWORDED = [
  // [wording in the extension, wording in Word]
  ["The API key is not set. Open the extension options to set it.", "The API key is not set. Enter it under Settings."],
  ["The API key was rejected. Check the key in the extension options: it may be mistyped or disabled.", "The API key was rejected. Check it under Settings: it may be mistyped or disabled."],
  // The Word add-in has no server address to enter, so "check the address" is dropped.
  ["Cannot reach the server. Check the address, and that you are on the company network or VPN.", "Cannot reach the server. Check that you are on the company network or VPN."],
];

export function forWord(message) {
  const found = REWORDED.find(([from]) => from === message);
  return found ? found[1] : String(message ?? "");
}

// Whether a message is about the key. If so, the task pane opens the settings for the user.
export function isAboutKey(message) {
  return /API key (is not set|was rejected)/.test(String(message ?? ""));
}
