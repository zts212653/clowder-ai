/** Proposed simulated world, in metres/seconds. No real duck calibration is implied. */
export const environment = {
  id: 'E1',
  windowSeconds: 26,
  duckStart: [0, 0],
  field: [8, 5],
  ballRadius: 0.035,
  goalPlaneX: 3.5,
  goalWidth: 1.2,
  goalHeight: 0.5,
  physics: 'same illustrative solver and material configuration in every paired run',
  seed: 17,
  truth: 'authored_mock_not_physics_simulation',
};
// [initial x, initial y, vx, vy]; negative y is right side. Same row, same input in a pair.
export const caseInputs: Record<string, number[][]> = {
  D1: [
    [1.4, 0.55, 0.08, 0],
    [2, 0.75, 0.07, 0.02],
    [1.6, 1.2, 0.06, -0.03],
    [1.4, -0.55, 0.08, 0],
    [2, -0.75, 0.07, -0.02],
    [1.6, -1.2, 0.06, 0.03],
  ],
  D2: [
    [1.5, 0.6, 0.09, 0],
    [1.8, 0.8, 0.1, 0.01],
    [2.1, 0.9, 0.11, 0.01],
    [1.7, 1, 0.08, -0.02],
    [2.2, 0.65, 0.07, 0],
    [1.9, 1.15, 0.09, -0.01],
    [1.6, 0.85, 0.1, 0.02],
    [2.3, 1.1, 0.11, -0.02],
  ],
};
export interface CalibrationEvent {
  contact: boolean;
  designatedFoot: boolean;
  inKickPhase: boolean;
  contactTime: number;
  crossingTime: number | null;
  wholeBall: boolean;
  insideGoal: boolean;
}
export function judgeGoal(event: CalibrationEvent): boolean {
  return (
    event.contact &&
    event.designatedFoot &&
    event.inKickPhase &&
    event.contactTime >= 0 &&
    event.crossingTime !== null &&
    event.crossingTime > event.contactTime &&
    event.crossingTime <= environment.windowSeconds &&
    event.wholeBall &&
    event.insideGoal
  );
}
const legal: CalibrationEvent = {
  contact: true,
  designatedFoot: true,
  inKickPhase: true,
  contactTime: 10.4,
  crossingTime: 12,
  wholeBall: true,
  insideGoal: true,
};
export const calibration = [
  { name: '球自行越线', event: { ...legal, contact: false }, expected: false },
  { name: '仅球心越线', event: { ...legal, wholeBall: false }, expected: false },
  { name: '踢球期外触碰', event: { ...legal, inKickPhase: false }, expected: false },
  { name: '合法触球后整球越线', event: legal, expected: true },
];
