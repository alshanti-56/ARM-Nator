import { TestBed } from "@angular/core/testing";
import { NativeCompositionService } from "./native-composition.service";
afterEach(() => TestBed.resetTestingModule());
it("late owners cannot reopen or clear a successor aperture", () => {
  const s = TestBed.inject(NativeCompositionService);
  const rect = { x: 10, y: 10, width: 100, height: 80 };
  s.beginSession("old");
  s.updateAperture({ sessionId: "old", bounds: rect, radius: 0 });
  s.beginSession("new");
  s.updateAperture({ sessionId: "new", bounds: rect, radius: 0 });
  s.updateAperture({ sessionId: "old", bounds: rect, radius: 0 });
  s.clearAperture("old");
  expect(s.aperture()?.sessionId).toBe("new");
  s.clearAperture("new");
  s.updateAperture({ sessionId: "new", bounds: rect, radius: 0 });
  expect(s.aperture()).toBeNull();
});
