const API_BASE = (process.env.DOCSWRITE_API_BASE || "https://api.docswrite.com").replace(/\/+$/, "");

export const config = {
    DOCSWRITE_API_BASE: API_BASE,
    DOCSWRITE_API_EXPORT: `${API_BASE}/api/export`,
    DOCSWRITE_API_JOB_STATUS: `${API_BASE}/api/job/status`,
    DOCSWRITE_APP_URL: "https://docswrite.com",
};
