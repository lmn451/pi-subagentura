import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ResponsiveFlowComponent,
  responsiveFlowColumnCount,
  responsiveFlowMinimumWidth,
} from "../src/rendering";

describe("responsive flow", () => {
  it("derives one, two, three, and four columns from readable width", () => {
    const rows = ["zero", "one", "two", "three", "four", "five", "six"];
    const component = new ResponsiveFlowComponent(rows);
    const oneColumnWidth = responsiveFlowMinimumWidth(2) - 1;
    const twoColumnWidth = responsiveFlowMinimumWidth(2);
    const threeColumnWidth = responsiveFlowMinimumWidth(3);
    const fourColumnWidth = responsiveFlowMinimumWidth(4);

    expect(responsiveFlowColumnCount(oneColumnWidth, rows.length)).toBe(1);
    expect(responsiveFlowColumnCount(twoColumnWidth, rows.length)).toBe(2);
    expect(responsiveFlowColumnCount(threeColumnWidth, rows.length)).toBe(3);
    expect(responsiveFlowColumnCount(fourColumnWidth, rows.length)).toBe(4);
    expect(component.render(oneColumnWidth)).toHaveLength(7);
    expect(component.render(twoColumnWidth)).toHaveLength(4);
    expect(component.render(threeColumnWidth)).toHaveLength(3);
    expect(component.render(fourColumnWidth)).toHaveLength(2);
    expect(responsiveFlowColumnCount(fourColumnWidth, 2)).toBe(2);
    expect("handleInput" in component).toBe(false);
  });

  it("keeps odd rows in stable row-major order across resize", () => {
    const component = new ResponsiveFlowComponent([
      "zero",
      "one",
      "two",
      "three",
      "four",
    ]);
    const threeColumns = component.render(responsiveFlowMinimumWidth(3));

    expect(threeColumns).toHaveLength(2);
    expect(threeColumns[0]).toMatch(/zero.*one.*two/);
    expect(threeColumns[1]).toMatch(/three.*four/);

    const twoColumns = component.render(responsiveFlowMinimumWidth(2));
    expect(twoColumns).toHaveLength(3);
    expect(twoColumns[0]).toMatch(/zero.*one/);
    expect(twoColumns[1]).toMatch(/two.*three/);
    expect(twoColumns[2]).toContain("four");
  });

  it("truncates long Unicode rows to display-cell bounds", () => {
    const width = responsiveFlowMinimumWidth(3);
    const component = new ResponsiveFlowComponent([
      "界🙂 alpha ".repeat(80),
      "界🙂 beta ".repeat(80),
      "界🙂 gamma ".repeat(80),
    ]);
    const rendered = component.render(width);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("界🙂 alpha");
    expect(rendered[0]).toContain("界🙂 beta");
    expect(rendered[0]).toContain("界🙂 gamma");
    expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
