export const CARD_BACKS = [
  { id: 'classic', name: 'Classic', file: null },
  { id: 'crown', name: 'Royal Crown', file: 'cardbacks/crown.jpg' },
  { id: 'compass', name: 'Star Compass', file: 'cardbacks/compass.jpg' },
  { id: 'shell', name: 'Pearl Shell', file: 'cardbacks/shell.jpg' },
  { id: 'leaf', name: 'Moonlit Leaf', file: 'cardbacks/leaf.jpg' },
  { id: 'crystal', name: 'Cosmic Crystal', file: 'cardbacks/crystal.jpg' },
];

export function cardBackById(id) {
  return CARD_BACKS.find((b) => b.id === id) || CARD_BACKS[0];
}
