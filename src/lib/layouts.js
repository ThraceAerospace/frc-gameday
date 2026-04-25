// lib/layouts.js

export const LAYOUTS = {
  single: {
    name: "Simple",
    slots: [
      { x: 0, y: 0, w: 100, h: 100 },
    ],
  },

  verticalSplit: {
    name: "Vertical Split",
    slots: [
      { x: 0, y: 0, w: 50, h: 100 },
      { x: 50, y: 0, w: 50, h: 100 },
    ],
  },

  horizontalSplit: {
    name: "Horizontal Split",
    slots: [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 50, w: 100, h: 50 },
    ],
  },

  onePlusTwo: {
    name: "1 + 2",
    slots: [
      { x: 0, y: 0, w: 60, h: 100 }, // main
      { x: 60, y: 0, w: 40, h: 50 },
      { x: 60, y: 50, w: 40, h: 50 },
    ],
  },

  quad: {
    name: "Quad",
    slots: [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 50, y: 0, w: 50, h: 50 },
      { x: 0, y: 50, w: 50, h: 50 },
      { x: 50, y: 50, w: 50, h: 50 },
    ],
  },

  onePlusThree: {
    name: "1 + 3",
    slots: [
      { x: 0, y: 0, w: 75, h: 100 }, // main
      { x: 75, y: 0, w: 25, h: 33.33 },
      { x: 75, y: 33.33, w: 25, h: 33.33 },
      { x: 75, y: 66.66, w: 25, h: 33.33 },
    ],
  },

  twoPlusThree: {
    name: "2 + 3",
    slots: [
      { x: 0, y:  0, w: 50, h: 60 }, // main
      { x: 50, y: 0, w: 50, h: 60 }, // secondary
      { x: 0, y: 60, w: 33.33, h: 40 },
      { x: 33.33, y: 60, w: 33.33, h: 40 },
      { x: 66.66, y: 60, w: 33.33, h: 40 },
    ],
  },

  hex: {
    name: "Hex",
    // 2 rows, 3 columns
    slots: [
      { x: 0, y: 0, w: 33.33, h: 50 },
      { x: 33.33, y: 0, w: 33.33, h: 50 },
      { x: 66.66, y: 0, w: 33.33, h: 50 },

      { x: 0, y: 50, w: 33.33, h: 50 },
      { x: 33.33, y: 50, w: 33.33, h: 50 },
      { x: 66.66, y: 50, w: 33.33, h: 50 },
    ],
  },

    twoPlusSix: {
    name: "2 + 6",
    slots: [
        // main (top middle)
        { x: 25, y: 0, w: 50, h: 50 },

        // Secondary (bottom middle)
        { x: 25, y: 49.95, w: 50, h: 50 },

        // left column (3 stacked)
        { x: 0, y: 0,     w: 25, h: 33.33 },
        { x: 0, y: 33.33, w: 25, h: 33.33 },
        { x: 0, y: 66.66, w: 25, h: 33.33 },

        // right column (3 stacked)
        { x: 75, y: 0, w: 25, h: 33.33 },
        { x: 75, y: 33.33, w: 25, h: 33.33 },
        { x: 75, y: 66.66, w: 25, h: 33.33 },
        
    ],
    },

  octo: {
    name: "Octo",
    // 2 rows × 4 columns
    slots: [
      { x: 0, y: 0, w: 25, h: 50 },
      { x: 25, y: 0, w: 25, h: 50 },
      { x: 50, y: 0, w: 25, h: 50 },
      { x: 75, y: 0, w: 25, h: 50 },

      { x: 0, y: 50, w: 25, h: 50 },
      { x: 25, y: 50, w: 25, h: 50 },
      { x: 50, y: 50, w: 25, h: 50 },
      { x: 75, y: 50, w: 25, h: 50 },
    ],
  },

  octoVertical: {
    name: "Vertical Octo",
    // 4 rows × 2 columns (alternative view)
    slots: [
      { x: 0, y: 0, w: 50, h: 25 },
      { x: 50, y: 0, w: 50, h: 25 },

      { x: 0, y: 25, w: 50, h: 25 },
      { x: 50, y: 25, w: 50, h: 25 },

      { x: 0, y: 50, w: 50, h: 25 },
      { x: 50, y: 50, w: 50, h: 25 },

      { x: 0, y: 75, w: 50, h: 25 },
      { x: 50, y: 75, w: 50, h: 25 },
    ],
  },
  onePlusEight: {
    name: "1 + 8",
    slots: [
        //main
        { x: 25, y:0, w:50, h:100},
        //left column
        { x: 0, y: 0, w:25, h:25 },
        { x: 0, y: 25, w:25, h:25 },
        { x: 0, y: 50, w:25, h:25 },
        { x: 0, y: 75, w:25, h:25 },
        //right column
        { x: 75, y: 0, w:25, h:25 },
        { x: 75, y: 25, w:25, h:25 },
        { x: 75, y: 50, w:25, h:25 },
        { x: 75, y: 75, w:25, h:25 },
    ]
  }
};


export function pickLayout(count) {
  if (count <= 1) return "single";
  if (count === 2) return "verticalSplit";
  if (count === 3) return "onePlusTwo";
  if (count === 4) return "quad";
  if (count <= 6) return "hex";
  if (count <= 7) return "onePlusSix";
  if (count <= 8) return "octo";
  return "onePlusEight";
}