import { render, fireEvent } from "@testing-library/svelte";
import { describe, it, expect, vi } from "vitest";
import WeekdayPicker from "./WeekdayPicker.svelte";
describe("WeekdayPicker", () => {
  it("adds a day without dropping the existing selection and prevents an empty selection", async () => {
    const onchange = vi.fn();
    const view = render(WeekdayPicker, { value: [1], onchange });
    expect(view.getByLabelText("週一")).toBeDisabled();
    await fireEvent.click(view.getByLabelText("週三"));
    expect(onchange).toHaveBeenCalledWith([1, 3]);
    await view.rerender({ value: [1, 3], onchange });
    await fireEvent.click(view.getByLabelText("週一"));
    expect(onchange).toHaveBeenLastCalledWith([3]);
  });
});
