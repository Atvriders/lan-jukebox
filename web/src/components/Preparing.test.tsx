// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Preparing } from "./Preparing.js";

afterEach(() => cleanup());

describe("Preparing", () => {
  it("renders nothing when preparing is null", () => {
    const { container } = render(<Preparing preparing={null} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("shows the downloading verb, title and percent", () => {
    render(
      <Preparing
        preparing={{ videoId: "v", title: "My Mix", phase: "downloading", percent: 42 }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Downloading/i);
    expect(screen.getByRole("status")).toHaveTextContent("My Mix");
    expect(screen.getByRole("status")).toHaveTextContent("42");
  });
});
