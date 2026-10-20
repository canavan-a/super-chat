import {chatTime} from '../src/screens/RoomScreen';

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();
const now = at(2026, 9, 19, 15, 0);
const time = (ts: number) => new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

it('shows only the time for today', () => {
  const ts = at(2026, 9, 19, 0, 5);
  expect(chatTime(ts, now)).toBe(time(ts));
});

it('says yesterday for yesterday', () => {
  const ts = at(2026, 9, 18, 23, 59);
  expect(chatTime(ts, now)).toBe(`Yesterday ${time(ts)}`);
});

it('adds the date before that, and the year when it differs', () => {
  const earlier = at(2026, 2, 3, 9, 30);
  expect(chatTime(earlier, now)).toBe(`${new Date(earlier).toLocaleDateString([], {month: 'short', day: 'numeric'})}, ${time(earlier)}`);
  const lastYear = at(2025, 2, 3, 9, 30);
  expect(chatTime(lastYear, now)).toContain('2025');
});
