// Color themes: each is a background gradient pair + a gold-equivalent accent pair.
// The swatch shown in the picker is a gradient of the two accent colors.
export const THEMES = [
  { id: 'classic', name: 'Classic Felt', desc: 'Emerald + gold', felt1: '#0b3d2a', felt2: '#082a1c', gold: '#ffd66e', goldDark: '#c99628' },
  { id: 'neon-rave', name: 'Neon Rave', desc: 'Mint, magenta + ultraviolet', felt1: '#2a0a3d', felt2: '#170622', gold: '#ff6ec7', goldDark: '#7b2ff7' },
  { id: 'aurora', name: 'Aurora', desc: 'Polar teal + violet glow', felt1: '#062a2f', felt2: '#03181c', gold: '#2dd4bf', goldDark: '#7c3aed' },
  { id: 'midnight-club', name: 'Midnight Club', desc: 'Deep blue + electric cyan', felt1: '#07223d', felt2: '#041526', gold: '#38bdf8', goldDark: '#2563eb' },
  { id: 'royal-velvet', name: 'Royal Velvet', desc: 'Violet + champagne gold', felt1: '#2a1140', felt2: '#170a26', gold: '#f5d78e', goldDark: '#8b5cf6' },
  { id: 'forest-rave', name: 'Forest Rave', desc: 'Pine green + glow lime', felt1: '#0b3d1f', felt2: '#052212', gold: '#a3e635', goldDark: '#16a34a' },
  { id: 'crimson-pulse', name: 'Crimson Pulse', desc: 'Red, rose + hot pink', felt1: '#3d0b17', felt2: '#22040c', gold: '#ff4d6d', goldDark: '#be123c' },
  { id: 'gold-rush', name: 'Gold Rush', desc: 'Yellow, amber + black', felt1: '#2a1d02', felt2: '#1a1100', gold: '#ffc107', goldDark: '#b45309' },
  { id: 'pink-nova', name: 'Pink Nova', desc: 'Fuchsia, pink + violet', felt1: '#3a0a3a', felt2: '#210521', gold: '#f472b6', goldDark: '#9333ea' },
  { id: 'cyberpunk', name: 'Cyberpunk', desc: 'Yellow, magenta + ink', felt1: '#1a0a2e', felt2: '#0d0517', gold: '#fbbf24', goldDark: '#ec4899' },
  { id: 'voltage', name: 'Voltage', desc: 'Electric blue + neon yellow', felt1: '#04263d', felt2: '#021a2b', gold: '#eab308', goldDark: '#0ea5e9' },
  { id: 'monochrome', name: 'Monochrome', desc: 'Ink, slate + silver', felt1: '#1c1f24', felt2: '#101215', gold: '#cbd5e1', goldDark: '#64748b' },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function applyTheme(id) {
  const t = themeById(id);
  const root = document.documentElement.style;
  root.setProperty('--felt1', t.felt1);
  root.setProperty('--felt2', t.felt2);
  root.setProperty('--gold', t.gold);
  root.setProperty('--gold-dark', t.goldDark);
  root.setProperty('--panel-bg', `${t.felt2}eb`);
}
