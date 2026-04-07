chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "OPEN_SIDE_PANEL") {
    chrome.sidePanel.open({ tabId: sender.tab.id });
  }
});
