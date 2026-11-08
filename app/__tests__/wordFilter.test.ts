import {censor} from '../src/moderation/wordFilter';
import {parseMarkdown} from '../src/markdown';

test('masks listed words, any case, keeping the length', () => {
  expect(censor('what the SHIT is this', true)).toBe('what the **** is this');
  expect(censor('Bitch, please.', true)).toBe('*****, please.');
});

test('masks a root inside any word', () => {
  expect(censor('motherfucker fuckin\' hell', true)).toBe("************ ******' hell");
});

test('leaves ordinary words containing a listed one alone', () => {
  const ok = 'spicy food, Dickens, a fagot of sticks, assholder? Scunthorpe, shiitake, classic';
  expect(censor(ok, true)).toBe(ok);
});

test('does nothing when off', () => {
  expect(censor('shit', false)).toBe('shit');
});

test('a masked link keeps its real URL', () => {
  const run = parseMarkdown('https://example.com/shit')[0].runs[0];
  expect(censor(run.value, true)).toBe('https://example.com/****');
  expect(run.url).toBe('https://example.com/shit');
});
