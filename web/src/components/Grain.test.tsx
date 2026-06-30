// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Grain } from "./Grain.js";

afterEach(() => cleanup());

describe("Grain", () => {
  it("renders an aria-hidden decorative layer", () => {
    const { container } = render(<Grain />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("aria-hidden", "true");
  });
});
