/**
 * Host half of dsh-obsidian-wikilinks.
 *
 * The whole feature lives in the browser (`client.js`): the Host only carries
 * the package so `dsh.client` ships that file to the Web client. Nothing runs
 * on this side.
 *
 * @module dsh-obsidian-wikilinks
 */

export const name = 'dsh-obsidian-wikilinks'

/** No Host behaviour; kept so the bundle patch resolves a real plugin. */
export function apply() {}
