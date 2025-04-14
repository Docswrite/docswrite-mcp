import fetch from 'node-fetch';
import { config } from './config.js';

export interface DocswriteRequestOptions {
    google_docs_url: string;
    title?: string;
    slug?: string;
    tags?: string;
    categories?: string;
    state?: string;
    author?: string;
    date?: string;
    excerpt?: string;
    post_type?: string;
    featured_image_url?: string;
    featured_image_alt_text?: string;
    featured_image_caption?: string;
    export_settings?: {
        compress_images?: boolean;
        demote_headings?: boolean;
        convert_to_webp?: boolean;
        first_image_as_featured_image?: boolean;
        add_no_follow_to_external_links?: boolean;
        bold_as_strong?: boolean;
        wp_content_editor?: string;
    };
    newspack_settings?: {
        newspack_article_summary?: string;
        newspack_article_summary_title?: string;
        newspack_post_subtitle?: string;
    };
    yoast_settings?: {
        yoast_focuskw?: string;
        yoast_metadesc?: string;
        yoast_title?: string;
    };
    rankmath_settings?: {
        rank_math_focus_keyword?: string;
    };
    token: string;
}

interface ContentResponse {
    [key: string]: unknown;
    type: "text";
    text: string;
}

export const makeDocswriteRequest = async ({
    google_docs_url,
    title,
    slug,
    tags,
    categories,
    state,
    author,
    date,
    excerpt,
    post_type,
    featured_image_url,
    featured_image_alt_text,
    featured_image_caption,
    export_settings,
    newspack_settings,
    yoast_settings,
    rankmath_settings,
    token
}: DocswriteRequestOptions): Promise<{ content: ContentResponse[] }> => {
    try {
        // 
        const response = await fetch(config.DOCSWRITE_API_EXPORT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-access-token': `${token}`
            },
            body: JSON.stringify({
                google_docs_url,
                title,
                slug,
                tags,
                categories,
                state,
                author,
                date,
                excerpt,
                post_type,
                featured_image_url,
                featured_image_alt_text,
                featured_image_caption,
                export_settings,
                newspack_settings,
                yoast_settings,
                rankmath_settings
            })
        });

        const data = await response.json();
        console.log(`Received response: ${JSON.stringify(data)}`);

        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(data),
                },
            ],
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error making Docswrite request: ${error.message}`,
                },
            ],
        };
    }
};

export interface JobStatusOptions {
    jobId: string;
    queueType: string;
    token: string;
}

export interface JobStatusResponse {
    id: string;
    state: 'completed' | 'failed' | 'active' | 'waiting' | 'delayed';
    progress: number;
    returnValue: Record<string, unknown>;
    failedReason: string | null;
    timestamp: number;
    processedOn: number;
    finishedOn: number;
}

export const checkJobStatus = async ({
    jobId,
    queueType,
    token
}: JobStatusOptions): Promise<{ content: ContentResponse[] }> => {
    try {
        const response = await fetch(config.DOCSWRITE_API_JOB_STATUS, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-access-token': `${token}`
            },
            body: JSON.stringify({
                jobId,
                queueType
            })
        });

        const data = await response.json();
        console.log(`Received job status response: ${JSON.stringify(data)}`);

        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(data),
                },
            ],
        };
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Error checking job status: ${error.message}`,
                },
            ],
        };
    }
}; 