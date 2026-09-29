/**
 * Org-key mode: which basic options each connection platform accepts, and the
 * `POST /api/posts` body for one (document, connection). The bodies mirror the
 * dashboard composer (docs2blog-frontend lib/composer/payloads.js
 * `buildPostPayload` + `modeFields`), with names instead of dashboard ids for
 * WordPress tags/categories/author (the API resolves or creates them).
 */

export type PostState = 'draft' | 'published' | 'scheduled';

export type BasicOption =
    | 'tags'
    | 'categories'
    | 'canonical_url'
    | 'excerpt'
    | 'slug'
    | 'featured_image_url'
    | 'author'
    | 'post_type';

export const BASIC_OPTIONS: BasicOption[] = [
    'tags', 'categories', 'canonical_url', 'excerpt', 'slug', 'featured_image_url', 'author', 'post_type',
];

interface PlatformSpec {
    label: string;
    /** false: X / LinkedIn, which the API cannot publish to (use the dashboard). */
    api: boolean;
    options: BasicOption[];
    maxTags?: number;
    note?: string;
}

const WORDPRESS: PlatformSpec = {
    label: 'WordPress',
    api: true,
    options: ['tags', 'categories', 'canonical_url', 'excerpt', 'slug', 'featured_image_url', 'author', 'post_type'],
    note: 'canonical_url is written to Yoast SEO (needs the Yoast plugin). Advanced: platform_options.wordpress.',
};

export const PLATFORMS: Record<string, PlatformSpec> = {
    wordpress: WORDPRESS,
    wordpress_plugin: { ...WORDPRESS, label: 'WordPress (plugin)' },
    docswrite: { label: 'Docswrite blog', api: true, options: ['tags', 'excerpt', 'slug', 'featured_image_url'] },
    contentful: {
        label: 'Contentful',
        api: true,
        options: [],
        note: 'Needs platform_options.contentful.model_id; fields (slug, tags, ...) are set through the content model mapping.',
    },
    webflow: {
        label: 'Webflow',
        api: true,
        options: [],
        note: 'Needs platform_options.webflow.collection_id; fields are set through the collection field mapping.',
    },
    shopify: {
        label: 'Shopify',
        api: true,
        options: ['tags', 'slug', 'author', 'featured_image_url'],
        note: 'Optional platform_options.shopify.blog_id (default: the store\'s first blog).',
    },
    github: {
        label: 'GitHub',
        api: true,
        options: ['tags', 'categories', 'excerpt', 'slug', 'author', 'featured_image_url'],
        note: 'Written as Markdown front matter. No drafts.',
    },
    devto: {
        label: 'Dev.to', api: true, maxTags: 4,
        options: ['tags', 'canonical_url', 'excerpt', 'featured_image_url'],
        note: 'Up to 4 tags. excerpt is the description. Optional platform_options.devto.series.',
    },
    hashnode: {
        label: 'Hashnode', api: true, maxTags: 5,
        options: ['tags', 'canonical_url', 'featured_image_url'],
        note: 'Up to 5 tags. Optional platform_options.hashnode.subtitle.',
    },
    medium: {
        label: 'Medium', api: true, maxTags: 3,
        options: ['tags', 'canonical_url', 'featured_image_url'],
        note: 'Medium uses the first 3 tags. Optional platform_options.medium.unlisted.',
    },
    ghost: {
        label: 'Ghost', api: true,
        options: ['tags', 'canonical_url', 'excerpt', 'slug', 'featured_image_url'],
    },
    twitter: { label: 'X (Twitter)', api: false, options: [], note: 'Social posts are written in the Docswrite dashboard; the API cannot publish them.' },
    linkedin: { label: 'LinkedIn', api: false, options: [], note: 'Social posts are written in the Docswrite dashboard; the API cannot publish them.' },
};

export const isWordPressFamily = (p: string) => p === 'wordpress' || p === 'wordpress_plugin';

export function platformSpec(platform: string): PlatformSpec {
    return PLATFORMS[platform] || { label: platform, api: false, options: [], note: 'This MCP server does not know this platform yet.' };
}

/** "a, b" | ["a", "b"] -> ["a", "b"] (trimmed, deduplicated) */
export function toList(input: unknown): string[] {
    const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
    const out: string[] = [];
    for (const t of raw) {
        const v = String(t ?? '').trim();
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

const GOOGLE_DOC_RE = /\/document\/(?:u\/\d+\/)?d\/([\w-]{10,})/;

/** A Google Doc URL or bare ID -> the ID, or null. */
export function googleDocId(input: string): string | null {
    const s = String(input || '').trim();
    const m = s.match(GOOGLE_DOC_RE);
    if (m) return m[1];
    if (/^[\w-]{20,}$/.test(s)) return s;
    return null;
}

export interface PublishInput {
    google_doc_id: string;
    title?: string;
    state: PostState;
    publish_date?: string;
    timezone?: string;
    tags?: string[];
    categories?: string[];
    canonical_url?: string;
    excerpt?: string;
    slug?: string;
    featured_image_url?: string;
    author?: string;
    post_type?: 'post' | 'page';
    platform_options?: Record<string, any>;
}

export interface Connection {
    id: string | number;
    platform: string;
    name?: string;
    capabilities?: Record<string, boolean>;
    [key: string]: unknown;
}

/** Basic options set in `input` that `platform` does not take. */
export function unsupportedOptions(platform: string, input: PublishInput): BasicOption[] {
    const allowed = new Set(platformSpec(platform).options);
    return BASIC_OPTIONS.filter((o) => {
        const v = (input as any)[o];
        const set = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
        return set && !allowed.has(o);
    });
}

/** Why `input` cannot go to `conn`, or null. */
export function blockerFor(conn: Connection, input: PublishInput): string | null {
    const platform = conn.platform;
    const spec = platformSpec(platform);
    if (!spec.api) {
        return `${spec.label} connections cannot be published to through the API. ${spec.note || ''}`.trim();
    }
    const caps = conn.capabilities || {};
    if (input.state === 'scheduled' && caps.schedule === false) return `${spec.label} connections do not support scheduling.`;
    if (input.state === 'draft' && caps.draft === false) {
        return `${spec.label} connections do not support drafts. Use state "published" or "scheduled".`;
    }
    const bad = unsupportedOptions(platform, input);
    if (bad.length) {
        const ok = spec.options.length ? spec.options.join(', ') : 'none of the basic options';
        return `Option${bad.length > 1 ? 's' : ''} ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not supported for ${spec.label}` +
            ` (supported: ${ok}).${spec.note ? ' ' + spec.note : ''} Remove ${bad.length > 1 ? 'them' : 'it'} or publish to this connection separately.`;
    }
    const po = input.platform_options?.[platform] || {};
    if (platform === 'contentful' && !po.model_id) {
        return 'Contentful needs platform_options.contentful.model_id (the content model to create the entry in).';
    }
    if (platform === 'webflow' && !po.collection_id) {
        return 'Webflow needs platform_options.webflow.collection_id (the CMS collection to create the item in).';
    }
    return null;
}

/** The composer's publishing-mode fields (lib/composer/payloads.js modeFields). */
export function modeFields(state: PostState, publish_date?: string, timezone?: string): Record<string, unknown> {
    if (state === 'scheduled') {
        return {
            state: 'draft',
            date: publish_date,
            publish_date,
            ...(timezone ? { publish_timezone: timezone } : {}),
        };
    }
    if (state === 'draft') return { state: 'draft' };
    return { state: 'published' };
}

/** Body for `POST /api/posts` publishing `input` to `conn` (assumes blockerFor() returned null). */
export function buildPostBody(conn: Connection, input: PublishInput): Record<string, unknown> {
    const platform = conn.platform;
    const spec = platformSpec(platform);
    const po = input.platform_options?.[platform] || {};
    const body: Record<string, unknown> = {
        connection_id: conn.id,
        google_doc_id: input.google_doc_id,
        destination: platform,
        ...(input.title ? { title: input.title } : {}),
    };
    const tags = input.tags || [];
    const set = (k: string, v: unknown) => {
        if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) body[k] = v;
    };

    switch (platform) {
        case 'wordpress':
        case 'wordpress_plugin':
        case 'docswrite': {
            // Names, comma-separated: the API finds or creates them in WordPress.
            set('tags', tags.join(', '));
            set('categories', (input.categories || []).join(', '));
            set('author', input.author);
            set('excerpt', input.excerpt);
            set('slug', input.slug);
            set('featured_image_url', input.featured_image_url);
            set('post_type', input.post_type);
            const yoast = { ...(po.yoast_settings || {}) };
            if (input.canonical_url) yoast.yoast_canonical = input.canonical_url;
            if (Object.keys(yoast).length) body.yoast_settings = yoast;
            set('rankmath_settings', po.rankmath_settings);
            set('newspack_settings', po.newspack_settings);
            set('export_settings', po.export_settings);
            if (po.template !== undefined) body.wp_template = po.template;
            break;
        }
        case 'contentful':
            body.data = {
                contentful: {
                    model_id: po.model_id,
                    field_mappings: po.field_mappings || {},
                    custom_values: po.custom_values || {},
                    locale: po.locale || 'en-US',
                },
            };
            break;
        case 'webflow':
            set('webflow_site_id', po.site_id);
            body.data = {
                webflow: {
                    collection_id: po.collection_id,
                    field_mappings: po.field_mappings || {},
                    custom_values: po.custom_values || {},
                },
            };
            break;
        case 'shopify':
            set('slug', input.slug);
            set('tags', tags);
            set('author', input.author);
            set('featured_image_url', input.featured_image_url);
            if (po.blog_id) body.data = { shopify: { blog_id: po.blog_id } };
            break;
        case 'github':
            set('slug', input.slug);
            set('tags', tags);
            set('categories', input.categories);
            set('author', input.author);
            set('excerpt', input.excerpt);
            set('featured_image_url', input.featured_image_url);
            body.github_settings = po.settings || {};
            break;
        case 'devto':
        case 'hashnode':
        case 'medium':
        case 'ghost': {
            const data: Record<string, unknown> = { tags: spec.maxTags ? tags.slice(0, spec.maxTags) : tags };
            if (input.canonical_url) data.canonical_url = input.canonical_url;
            if (input.featured_image_url) data.cover_image_url = input.featured_image_url;
            if (platform === 'devto' && po.series) data.series = String(po.series).trim();
            if (platform === 'hashnode' && po.subtitle) data.subtitle = String(po.subtitle).trim();
            if (platform === 'medium' && po.unlisted) data.publish_status = 'unlisted';
            if (platform === 'devto' && input.excerpt) data.description = input.excerpt;
            if (platform === 'ghost' && input.excerpt) data.custom_excerpt = input.excerpt;
            if (platform === 'ghost' && input.slug) data.slug = input.slug;
            body.tags = data.tags;
            set('featured_image_url', input.featured_image_url);
            set('excerpt', input.excerpt);
            body.data = { [platform]: data };
            break;
        }
        default:
            set('slug', input.slug);
    }

    return { ...body, ...modeFields(input.state, input.publish_date, input.timezone) };
}

/** Summary of what a connection can do through this MCP server. */
export function describeSupport(conn: Connection) {
    const spec = platformSpec(conn.platform);
    const caps = conn.capabilities || {};
    const states: PostState[] = [];
    if (spec.api) {
        if (caps.publish !== false) states.push('published');
        if (caps.draft !== false) states.push('draft');
        if (caps.schedule !== false) states.push('scheduled');
    }
    return {
        publishable_via_api: spec.api,
        states,
        options: spec.options,
        ...(spec.note ? { note: spec.note } : {}),
    };
}

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function zoneOffsetMs(utcMs: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return local - Math.floor(utcMs / 1000) * 1000;
}

export function isValidTimeZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * The UTC instant of `date` ("YYYY-MM-DDTHH:mm" read in `timeZone`, or any
 * ISO date with an offset), or null when it cannot be parsed.
 */
export function resolveInstant(date: string, timeZone?: string): Date | null {
    const s = String(date || '').trim();
    const m = s.match(NAIVE_RE);
    if (m && timeZone) {
        const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
        let guess = asUtc - zoneOffsetMs(asUtc, timeZone);
        guess = asUtc - zoneOffsetMs(guess, timeZone);
        return new Date(guess);
    }
    const d = new Date(m ? `${s}Z` : s);
    return Number.isNaN(d.getTime()) ? null : d;
}
