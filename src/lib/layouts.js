// src/lib/layouts.js

const VISIBLE = "visible";
const HIDDEN = "hidden";

const LARGE = {
  matchInfo: VISIBLE,
  teamTracker: VISIBLE,
};

const COMPACT = {
  matchInfo: HIDDEN,
  teamTracker: VISIBLE,
};

const NONE = {
  matchInfo: HIDDEN,
  teamTracker: HIDDEN,
};

export const LAYOUTS = {
  // 1
  single: {
    name: "Single",

    slots: [
      { x: 0, y: 0, w: 100, h: 100, presentation: LARGE },
    ],
  },

  // 2
  verticalSplit: {
    name: "Dual",

    slots: [
      { x: 0, y: 0, w: 50, h: 100, presentation: LARGE },
      { x: 50, y: 0, w: 50, h: 100, presentation: LARGE },
    ],
  },

  // 3
  onePlusTwo: {
    name: "1 + 2",

    slots: [
      { x: 0, y: 0, w: 60, h: 100, presentation: LARGE },
      { x: 60, y: 0, w: 40, h: 50, presentation: LARGE },
      { x: 60, y: 50, w: 40, h: 50, presentation: LARGE },
    ],
  },

  // 4
  quad: {
    name: "Quad",

    slots: [
      { x: 0, y: 0, w: 50, h: 50, presentation: LARGE },
      { x: 50, y: 0, w: 50, h: 50, presentation: LARGE },
      { x: 0, y: 50, w: 50, h: 50, presentation: LARGE },
      { x: 50, y: 50, w: 50, h: 50, presentation: LARGE },
    ],
  },

  onePlusThree: {
    name: "1 + 3",

    slots: [
      { x: 0, y: 0, w: 75, h: 100, presentation: LARGE },
      { x: 75, y: 0, w: 25, h: 33.33, presentation: COMPACT },
      { x: 75, y: 33.33, w: 25, h: 33.33, presentation: COMPACT },
      { x: 75, y: 66.66, w: 25, h: 33.33, presentation: COMPACT },
    ],
  },

  // 5
  twoPlusThree: {
    name: "2 + 3",

    slots: [
      { x: 0, y: 0, w: 50, h: 60, presentation: LARGE },
      { x: 50, y: 0, w: 50, h: 60, presentation: LARGE },

      { x: 0, y: 60, w: 33.33, h: 40, presentation: COMPACT },
      { x: 33.33, y: 60, w: 33.33, h: 40, presentation: COMPACT },
      { x: 66.66, y: 60, w: 33.33, h: 40, presentation: COMPACT },
    ],
  },

  // 6
  hex: {
    name: "Hex",

    slots: [
      { x: 0, y: 0, w: 33.33, h: 50, presentation: COMPACT },
      { x: 33.33, y: 0, w: 33.33, h: 50, presentation: COMPACT },
      { x: 66.66, y: 0, w: 33.33, h: 50, presentation: COMPACT },

      { x: 0, y: 50, w: 33.33, h: 50, presentation: COMPACT },
      { x: 33.33, y: 50, w: 33.33, h: 50, presentation: COMPACT },
      { x: 66.66, y: 50, w: 33.33, h: 50, presentation: COMPACT },
    ],
  },

  onePlusFive: {
    name: "1 + 5",

    slots: [
      { x: 0, y: 0, w: 70, h: 100, presentation: LARGE },

      { x: 70, y: 0, w: 30, h: 33.33, presentation: COMPACT },

      { x: 85, y: 33.33, w: 15, h: 33.33, presentation: COMPACT },
      { x: 70, y: 33.33, w: 15, h: 33.33, presentation: COMPACT },

      { x: 85, y: 66.66, w: 15, h: 33.33, presentation: COMPACT },
      { x: 70, y: 66.66, w: 15, h: 33.33, presentation: COMPACT },
    ],
  },

  // 7
  onePlusSix: {
    name: "1 + 6",

    slots: [
      { x: 0, y: 0, w: 70, h: 100, presentation: LARGE },

      { x: 70, y: 0, w: 15, h: 33.33, presentation: COMPACT },
      { x: 85, y: 0, w: 15, h: 33.33, presentation: COMPACT },

      { x: 70, y: 33.33, w: 15, h: 33.33, presentation: COMPACT },
      { x: 85, y: 33.33, w: 15, h: 33.33, presentation: COMPACT },

      { x: 70, y: 66.66, w: 15, h: 33.33, presentation: COMPACT },
      { x: 85, y: 66.66, w: 15, h: 33.33, presentation: COMPACT },
    ],
  },

  // 8
  octo: {
    name: "Octo",

    slots: [
      { x: 0, y: 0, w: 25, h: 50, presentation: COMPACT },
      { x: 25, y: 0, w: 25, h: 50, presentation: COMPACT },
      { x: 50, y: 0, w: 25, h: 50, presentation: COMPACT },
      { x: 75, y: 0, w: 25, h: 50, presentation: COMPACT },

      { x: 0, y: 50, w: 25, h: 50, presentation: COMPACT },
      { x: 25, y: 50, w: 25, h: 50, presentation: COMPACT },
      { x: 50, y: 50, w: 25, h: 50, presentation: COMPACT },
      { x: 75, y: 50, w: 25, h: 50, presentation: COMPACT },
    ],
  },

  twoPlusSix: {
    name: "2 + 6",

    slots: [
      { x: 25, y: 0, w: 50, h: 50, presentation: LARGE },
      { x: 25, y: 50, w: 50, h: 50, presentation: LARGE },

      { x: 0, y: 0, w: 25, h: 33.33, presentation: COMPACT },
      { x: 0, y: 33.33, w: 25, h: 33.33, presentation: COMPACT },
      { x: 0, y: 66.66, w: 25, h: 33.33, presentation: COMPACT },

      { x: 75, y: 0, w: 25, h: 33.33, presentation: COMPACT },
      { x: 75, y: 33.33, w: 25, h: 33.33, presentation: COMPACT },
      { x: 75, y: 66.66, w: 25, h: 33.33, presentation: COMPACT },
    ],
  },

  // 9
  nineGrid: {
    name: "Nona",

    slots: [
      { x: 0, y: 0, w: 33.333, h: 33.333, presentation: COMPACT },
      { x: 33.333, y: 0, w: 33.333, h: 33.333, presentation: COMPACT },
      { x: 66.666, y: 0, w: 33.333, h: 33.333, presentation: COMPACT },

      { x: 0, y: 33.333, w: 33.333, h: 33.333, presentation: COMPACT },
      { x: 33.333, y: 33.333, w: 33.333, h: 33.333, presentation: COMPACT },
      { x: 66.666, y: 33.333, w: 33.333, h: 33.333, presentation: COMPACT },

      { x: 0, y: 66.666, w: 33.333, h: 33.333, presentation: COMPACT },
      { x: 33.333, y: 66.666, w: 33.333, h: 33.333, presentation: COMPACT },
      { x: 66.666, y: 66.666, w: 33.333, h: 33.333, presentation: COMPACT },
    ],
  },

  onePlusEight: {
    name: "1 + 8",

    slots: [
      { x: 0, y: 0, w: 70, h: 100, presentation: LARGE },

      { x: 70, y: 0, w: 15, h: 25, presentation: NONE },
      { x: 85, y: 0, w: 15, h: 25, presentation: NONE },

      { x: 70, y: 25, w: 15, h: 25, presentation: NONE },
      { x: 85, y: 25, w: 15, h: 25, presentation: NONE },

      { x: 70, y: 50, w: 15, h: 25, presentation: NONE },
      { x: 85, y: 50, w: 15, h: 25, presentation: NONE },

      { x: 70, y: 75, w: 15, h: 25, presentation: NONE },
      { x: 85, y: 75, w: 15, h: 25, presentation: NONE },
    ],
  },
};

/*
 * Select the default layout based on the number of slots.
 *
 * The default layout is the standard equal-weight layout where one exists.
 * For slot counts without a separate equal-weight layout, the available
 * composite layout is used.
 */
export function pickLayout(count) {
  if (count <= 1) return "single";
  if (count === 2) return "verticalSplit";
  if (count === 3) return "onePlusTwo";
  if (count === 4) return "quad";
  if (count === 5) return "twoPlusThree";
  if (count === 6) return "hex";
  if (count === 7) return "onePlusSix";
  if (count === 8) return "octo";
  return "nineGrid";
}

/*
 * Select the layout used when one or more events are highlighted.
 *
 * `count` is the number of slots currently on screen,
 * rather than the number of occupied streams.
 *
 * Where a dedicated highlight layout exists, it is preferred.
 * Otherwise the normal layout for that slot count is used.
 */
export function pickHighlightLayout(count) {
  if (count <= 1) return "single";
  if (count === 2) return "verticalSplit";
  if (count === 3) return "onePlusTwo";
  if (count === 4) return "onePlusThree";
  if (count === 5) return "twoPlusThree";
  if (count === 6) return "onePlusFive";
  if (count === 7) return "onePlusSix";
  if (count === 8) return "twoPlusSix";
  return "onePlusEight";
}