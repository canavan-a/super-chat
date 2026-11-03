import {InlineRun, parseMarkdown} from '../src/markdown';

const runs = (text: string): InlineRun[] => parseMarkdown(text)[0].runs;
const links = (text: string) => runs(text).filter(r => r.url).map(r => r.url);

test('detects https links and leaves trailing punctuation out', () => {
  expect(links('see https://example.com/a_b_c.')).toEqual(['https://example.com/a_b_c']);
  expect(links('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  expect(links('Https://Example.com')).toEqual(['https://Example.com']);
});

test('ignores http and bare domains', () => {
  expect(links('http://example.com example.com https://')).toEqual([]);
});

test('leaves code, emphasis and list markers as typed', () => {
  const r = runs('- `a` *hi* https://a.co/x_y _there_');
  expect(r.map(x => [x.value, x.url])).toEqual([
    ['- `a` *hi* ', undefined],
    ['https://a.co/x_y', 'https://a.co/x_y'],
    [' _there_', undefined],
  ]);
});
