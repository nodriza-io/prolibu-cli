/**
 * Asset utilities for Prolibu plugins.
 *
 * These helpers resolve asset URLs correctly in both dev and production environments.
 *
 * In dev mode: Assets are served from /src/assets/
 * In production: Assets are served from the plugin's CDN path
 */

/**
 * Gets the base URL where plugin assets are hosted.
 * Works in both dev mode (localhost) and production (CDN).
 *
 * @param pluginCode - Your plugin code (e.g., 'my-plugin')
 * @returns The base URL or empty string in dev mode
 */
export const getPluginBaseUrl = (pluginCode: string): string => {
  try {
    const script = document.getElementById(`${pluginCode}-js`) as HTMLScriptElement;
    if (script?.src) {
      // Remove the .js filename to get the base path
      return script.src.replace(/\/[^/]+\.js$/, '');
    }
  } catch (e) {
    console.warn('Could not determine plugin base URL:', e);
  }
  return '';
};

/**
 * Resolves an asset path to its full URL.
 * Automatically handles dev vs production environments.
 *
 * @param pluginCode - Your plugin code (e.g., 'my-plugin')
 * @param assetPath - Relative path from assets folder (e.g., 'images/logo.svg')
 * @returns The full URL to the asset
 *
 * @example
 * // In dev mode:
 * getAssetUrl('my-plugin', 'images/logo.svg')
 * // Returns: '/src/assets/images/logo.svg'
 *
 * // In production:
 * getAssetUrl('my-plugin', 'images/logo.svg')
 * // Returns: 'https://domain.com/plugins/.../my-plugin/assets/images/logo.svg'
 */
export const getAssetUrl = (pluginCode: string, assetPath: string): string => {
  const baseUrl = getPluginBaseUrl(pluginCode);
  if (!baseUrl) {
    // Dev mode: assets served from src/assets/
    return `/src/assets/${assetPath}`;
  }
  return `${baseUrl}/assets/${assetPath}`;
};

/**
 * Creates a hook-like function for getting asset URLs with a fixed plugin code.
 * Useful when you have multiple assets in a component.
 *
 * @param pluginCode - Your plugin code
 * @returns A function that takes an asset path and returns the full URL
 *
 * @example
 * const getAsset = createAssetGetter('my-plugin');
 * const logoUrl = getAsset('images/logo.svg');
 * const badgeUrl = getAsset('images/badge.png');
 */
export const createAssetGetter = (pluginCode: string) => {
  return (assetPath: string): string => getAssetUrl(pluginCode, assetPath);
};
