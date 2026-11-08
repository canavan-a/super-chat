import {censor, cleanWord} from '../src/moderation/wordFilter';
import {parseMarkdown} from '../src/markdown';

const LIST = ['shit', 'bitch', 'spic', 'dick'];
const on = (filterList: string[] = LIST) => ({filterWords: true, filterList, filterBuiltIn: false});

test('masks words on the list, any case, keeping the length', () => {
  expect(censor('what the SHIT is this', on())).toBe('what the **** is this');
  expect(censor('Bitch, please.', on())).toBe('*****, please.');
  expect(censor('shit shit', on())).toBe('**** ****');
});

test('matches whole words only', () => {
  const ok = 'spicy food, Dickens, shiitake';
  expect(censor(ok, on())).toBe(ok);
});

test('uses only the words the person added', () => {
  expect(censor('broccoli and shit', on(['broccoli']))).toBe('******** and shit');
  expect(censor('shit', on([]))).toBe('shit');
});

test('handles phrases, accents and regex characters', () => {
  expect(censor('no Way José!', on(['no way', 'josé']))).toBe('****** ****!');
  expect(censor('a.b and c++ here', on(['c++', 'a.b']))).toBe('*** and *** here');
  expect(censor('axb', on(['a.b']))).toBe('axb');
});

test('does nothing when off', () => {
  expect(censor('shit', {filterWords: false, filterList: LIST, filterBuiltIn: true})).toBe('shit');
});

test('cleans typed words', () => {
  expect(cleanWord('  Bad   Word ')).toBe('bad word');
});

test('a masked link keeps its real URL', () => {
  const run = parseMarkdown('https://example.com/shit')[0].runs[0];
  expect(censor(run.value, on())).toBe('https://example.com/****');
  expect(run.url).toBe('https://example.com/shit');
});

test('the built-in list only applies when turned on', () => {
  expect(censor('total bullshit', {filterWords: true, filterList: [], filterBuiltIn: false})).toBe('total bullshit');
  expect(censor('total bullshit', {filterWords: true, filterList: [], filterBuiltIn: true})).toBe('total ********');
  expect(censor('broccoli bullshit', {filterWords: true, filterList: ['broccoli'], filterBuiltIn: true})).toBe('******** ********');
});
