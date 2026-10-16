/// <reference types="chrome" />
// Toolbar button: open swipe mode on the current Google Photos tab, or open
// Google Photos if this tab isn't one (no content script to answer).

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { gptkSwipe: 'open' }).catch(() => {
    void chrome.tabs.create({ url: 'https://photos.google.com/' });
  });
});
