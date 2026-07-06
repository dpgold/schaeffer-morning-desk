// Proxy RSS feeds to avoid CORS — health care news sources only
export default async (req) => {
  const url = new URL(req.url);
  const feed = url.searchParams.get('feed');

  if (!feed) return new Response('Missing feed param', { status: 400 });

  const ALLOWED_DOMAINS = [
    // KFF Health News
    'kff.org', 'www.kff.org',
    // STAT News
    'www.statnews.com', 'statnews.com',
    // Health Affairs
    'www.healthaffairs.org', 'healthaffairs.org',
    // Modern Healthcare
    'www.modernhealthcare.com', 'modernhealthcare.com',
    // Fierce Healthcare (direct feed is Cloudflare-blocked from datacenter IPs —
    // pulled via Google News RSS instead; see news.google.com below)
    'www.fiercehealthcare.com', 'fiercehealthcare.com',
    // Google News RSS (workaround source for Cloudflare-blocked sites)
    'news.google.com',
    // Science (AAAS) — native feed is Cloudflare-fronted; primary source is Google News
    'www.science.org', 'science.org',
    // NIH
    'www.nih.gov', 'nih.gov',
    // Politico Health
    'rss.politico.com', 'www.politico.com', 'politico.com',
    // NPR Health
    'feeds.npr.org', 'npr.org',
    // MedPage Today
    'www.medpagetoday.com', 'medpagetoday.com',
    // BioPharma Dive
    'www.biopharmadive.com', 'biopharmadive.com',
    // Reuters
    'feeds.reuters.com', 'rss.reuters.com', 'reuters.com',
    // NEJM
    'www.nejm.org', 'nejm.org',
    // Commonwealth Fund
    'www.commonwealthfund.org', 'commonwealthfund.org',
    // Managed Care Magazine
    'www.managedcaremag.com', 'managedcaremag.com',
    // Inside Health Policy
    'insidehealthpolicy.com', 'www.insidehealthpolicy.com',
    // The Hill Health
    'thehill.com', 'www.thehill.com',
    // AP Health
    'apnews.com', 'www.apnews.com',
    // Generic feedburner/substack
    'feeds.feedburner.com',
  ];

  let feedHost;
  try { feedHost = new URL(feed).hostname; } catch(e) {
    return new Response('Invalid feed URL', { status: 400 });
  }
  if (!ALLOWED_DOMAINS.includes(feedHost)) {
    return new Response('Feed domain not allowed: ' + feedHost, { status: 403 });
  }

  try {
    const feedOrigin = new URL(feed).origin;
    const r = await fetch(feed, {
      // Full browser-like header set — some sources (e.g. Fierce Healthcare, behind
      // Cloudflare) serve a bot/challenge page to a bare UA from a datacenter IP,
      // which has no <item> tags and parses to an empty feed.
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,application/atom+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': feedOrigin + '/',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': '"Chromium";v="126", "Not.A/Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      }
    });
    const xml = await r.text();

    // ?debug=1 → surface what the function actually received (status, size, first
    // items), so a "feed returns nothing" case can be diagnosed without guessing.
    if (url.searchParams.get('debug')) {
      return new Response(JSON.stringify({
        status: r.status, contentType: r.headers.get('content-type'),
        server: r.headers.get('server'), length: xml.length,
        itemTags: (xml.match(/<item[\s>]/g) || []).length,
        sample: xml.slice(0, 1500),
      }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const clean = s => {
      let t = (s || '');
      // Strip HTML tags — loop until stable (handles broken/nested tags)
      let prev;
      do { prev = t; t = t.replace(/<[^>]*>/g, ''); } while (t !== prev);
      // Decode numeric entities
      t = t.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      t = t.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
      // Decode named entities
      t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
           .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
           .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
           .replace(/&lsquo;/g, '‘').replace(/&rsquo;/g, '’')
           .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
           .replace(/&nbsp;/g, ' ').replace(/&hellip;/g, '…');
      // Truncate long descriptions to a clean sentence-ish length
      t = t.trim();
      if (t.length > 220) {
        const cut = t.lastIndexOf(' ', 220);
        t = t.slice(0, cut > 100 ? cut : 220) + '…';
      }
      return t;
    };

    const getTag = (block, tag) => {
      let m = block.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`));
      if (m) return m[1].trim();
      m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`));
      if (m) return m[1].trim();
      m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      if (m) return m[1].trim();
      return '';
    };

    const items = [];

    // Try RSS <item> first
    const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const b = match[1];
      const link = getTag(b, 'link') || (b.match(/<link[^>]+href="([^"]+)"/) || [])[1] || '';
      items.push({
        title: clean(getTag(b, 'title')),
        author: clean(getTag(b, 'dc:creator') || getTag(b, 'author')),
        description: clean(getTag(b, 'description') || getTag(b, 'content:encoded')),
        link: clean(link)
      });
    }

    // Fall back to Atom <entry>
    if (!items.length) {
      const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/g;
      while ((match = entryRegex.exec(xml)) !== null && items.length < 5) {
        const b = match[1];
        const linkMatch = b.match(/<link[^>]+href="([^"]+)"/) || b.match(/<link[^>]*>([^<]+)<\/link>/);
        const link = linkMatch ? linkMatch[1] : '';
        items.push({
          title: clean(getTag(b, 'title')),
          author: clean(getTag(b, 'name') || getTag(b, 'author')),
          description: clean(getTag(b, 'summary') || getTag(b, 'content')),
          link: clean(link)
        });
      }
    }

    // Google News RSS (Cloudflare-block workaround): titles carry a " - Source"
    // suffix and the description is just a link blob, not a real summary. Trim the
    // suffix and drop the junk description so cards read like the other feeds.
    if (feedHost === 'news.google.com') {
      for (const it of items) {
        it.title = (it.title || '').replace(/\s+-\s+[^\-–—]+$/, '').trim();
        it.description = '';
      }
    }

    const allEmpty = items.length > 0 && items.every(i => !i.title);
    if (allEmpty) {
      return new Response(JSON.stringify({ items, _debug: xml.slice(0, 2000) }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ items }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = { path: '/api/rss' };
