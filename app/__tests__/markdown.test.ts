import {InlineRun, parseMarkdown} from '../src/markdown';

const runs = (text: string): InlineRun[] => {
  const seg = parseMarkdown(text)[0];
  return seg.kind === 'code-block' ? [] : seg.runs;
};
const links = (text: string) => runs(text).filter(r => r.url).map(r => r.url);

test('detects https links and leaves trailing punctuation out', () => {
  expect(links('see https://example.com/a_b_c.')).toEqual(['https://example.com/a_b_c']);
  expect(links('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  expect(links('Https://Example.com')).toEqual(['https://Example.com']);
});

test('ignores http, bare domains and links in code', () => {
  expect(links('http://example.com example.com https://')).toEqual([]);
  expect(links('`https://example.com`')).toEqual([]);
});

test('keeps emphasis around links', () => {
  const r = runs('*hi* https://a.co/x_y _there_');
  expect(r.map(x => [x.value, !!x.italic, x.url])).toEqual([
    ['hi', true, undefined],
    [' ', false, undefined],
    ['https://a.co/x_y', false, 'https://a.co/x_y'],
    [' ', false, undefined],
    ['there', true, undefined],
  ]);
});
