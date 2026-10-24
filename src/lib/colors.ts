export function colorHex(color: {
  type: string;
  value: string;
  tint: number;
  pattern?: string | null;
}) {
  if (!color.pattern) return "F1F5EC";
  if (color.type === "rgb") return color.value.slice(-6);
  const theme = [
    "FFFFFF",
    "000000",
    "EEECE1",
    "1F497D",
    "4F81BD",
    "C0504D",
    "9BBB59",
    "8064A2",
    "4BACC6",
    "F79646",
  ];
  let h = theme[Number(color.value)] || "E8F3F0";
  if (color.tint) {
    h = h
      .match(/../g)!
      .map((v) => {
        let x = parseInt(v, 16);
        x = color.tint < 0 ? x * (1 + color.tint) : x + (255 - x) * color.tint;
        return Math.round(x).toString(16).padStart(2, "0");
      })
      .join("");
  }
  return h;
}
