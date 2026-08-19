/**
 * Small DOM helpers shared by the UI modules.
 */

/**
 * Escape HTML for safe interpolation into a template string.
 * @param {string} text
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}
