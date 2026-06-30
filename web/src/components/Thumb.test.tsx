// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Thumb } from "./Thumb.js";

afterEach(() => cleanup());

describe("Thumb", () => {
  it("renders an <img> when given a url", () => {
    const { container } = render(<Thumb url="https://i.ytimg.com/x.jpg" />);
    // The thumbnail is decorative (alt=""), so it exposes the presentation role
    // rather than "img"; assert on the actual <img> element's src.
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://i.ytimg.com/x.jpg");
  });
  it("renders the placeholder slot when url is null", () => {
    render(<Thumb url={null} />);
    expect(screen.getByTestId("thumb-placeholder")).toBeInTheDocument();
  });
});
