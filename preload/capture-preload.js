const { desktopCapturer } = require('electron');

window.__getDesktopSources = async (width, height) => {
  const debug = {
    hasDesktopCapturer: !!desktopCapturer,
    hasGetSources: !!desktopCapturer?.getSources,
    electronKeys: [],
    processType: typeof process !== 'undefined' ? process.type : 'unknown',
  };
  try {
    debug.electronKeys = Object.keys(require('electron') || {});
  } catch (err) {
    debug.electronKeys = [];
  }
  if (!desktopCapturer || !desktopCapturer.getSources) {
    return { __error: 'desktopCapturer unavailable', __debug: debug };
  }
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: true,
  });
  return sources.map((source) => ({
    id: source.id,
    title: source.name || '',
    thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : '',
    appIcon: source.appIcon ? source.appIcon.toDataURL() : '',
  }));
};
