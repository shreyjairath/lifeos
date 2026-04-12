import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { Redfin } from '../../../agentfleet/tools/redfin.js';

let fetchSpy: ReturnType<typeof spyOn>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

function mockFetchHtml(html: string, status = 200, url = 'https://www.redfin.com/listing/123'): void {
  const resp = new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
  Object.defineProperty(resp, 'url', { value: url });
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(resp);
}

const JSON_LD_HTML = `
<html>
<head>
<script type="application/ld+json">
{"@type":"SingleFamilyResidence","address":{"streetAddress":"123 Main St","addressLocality":"Springfield","addressRegion":"IL","postalCode":"62701"},"price":"450000","numberOfRooms":3,"numberOfBathroomsTotal":2,"geo":{"latitude":"39.7","longitude":"-89.6"}}
</script>
</head>
<body><h1>123 Main St</h1></body>
</html>
`;

const DOM_HTML = `
<html><head><title>456 Oak Ave, Chicago | Redfin</title></head>
<body>
<span class="price"><span class="value">$350,000</span></span>
<span class="beds"><span class="value">2</span></span>
<span class="baths"><span class="value">1</span></span>
</body>
</html>
`;

describe('Redfin.parseListing', () => {
  it('extracts data from JSON-LD structured data', async () => {
    mockFetchHtml(JSON_LD_HTML);
    const r = new Redfin();
    const result = await r.parseListing('https://www.redfin.com/listing/123');
    expect(result.address).toContain('123 Main St');
    expect(result.price).toBe('450000');
    expect(result.beds).toBe(3);
  });

  it('falls back to DOM extraction', async () => {
    mockFetchHtml(DOM_HTML);
    const r = new Redfin();
    const result = await r.parseListing('https://www.redfin.com/listing/456');
    expect(result.price ?? result.address).toBeTruthy(); // at least one field extracted
  });

  it('returns error on HTTP failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 })
    );
    const r = new Redfin();
    const result = await r.parseListing('https://www.redfin.com/bad');
    expect(result.error).toBeDefined();
  });

  it('returns error on network failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
    const r = new Redfin();
    const result = await r.parseListing('https://www.redfin.com/listing/999');
    expect(result.error).toBeDefined();
  });
});

describe('Redfin.parseSearch', () => {
  it('returns error on fetch failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const r = new Redfin();
    const result = await r.parseSearch({ zipcode: '60601' });
    expect(result.error).toBeDefined();
  });

  it('returns error on HTTP 429', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Rate limited', { status: 429 })
    );
    const r = new Redfin();
    const result = await r.parseSearch({ zipcode: '60601' });
    expect(result.error).toBeDefined();
  });
});
