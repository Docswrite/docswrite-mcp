import { google } from "googleapis";
import { docs_v1, drive_v3 } from "googleapis";
import { authorize, resolveCredentialsPath } from "./auth.js";
import { textResult, ToolResult } from "./utils.js";

let docsClient: docs_v1.Docs;
let driveClient: drive_v3.Drive;
let clientsReady = false;

/** True when a Google OAuth client file is configured, i.e. the Google Docs tools can work. */
export function googleDocsConfigured(): boolean {
    return resolveCredentialsPath() !== null;
}

/**
 * Lazily authorize the Google clients on first use. Returns null when ready,
 * or a tool result explaining what the user has to do first.
 */
async function ensureClients(): Promise<ToolResult | null> {
    if (clientsReady) return null;
    const credentialsPath = resolveCredentialsPath();
    if (!credentialsPath) {
        return textResult(
            "Google Docs tools are not configured. Start the MCP server with --googleCredentials <path to Google OAuth client JSON> " +
            "(or GOOGLE_CREDENTIALS_PATH). Publishing an existing Google Doc with docswrite-publish does not need this.",
            true
        );
    }
    try {
        const auth = await authorize(credentialsPath);
        if (auth.status === "needs_consent") {
            return textResult(
                `Google Docs access is not authorized yet. Ask the user to open this URL, approve access, then retry:\n${auth.authUrl}`,
                true
            );
        }
        docsClient = google.docs({ version: "v1", auth: auth.client as any });
        driveClient = google.drive({ version: "v3", auth: auth.client as any });
        clientsReady = true;
        return null;
    } catch (error: any) {
        console.error("Failed to initialize Google API clients:", error);
        return textResult(`Could not initialize Google Docs access: ${error?.message || error}`, true);
    }
}

export async function createDoc(title: string, content: string = ""): Promise<ToolResult> {
    const notReady = await ensureClients();
    if (notReady) return notReady;
    try {
        // Create a new document
        const doc = await docsClient.documents.create({
            requestBody: {
                title: title,
            },
        });

        const documentId = doc.data.documentId;

        // If content was provided, add it to the document
        if (content) {
            await docsClient.documents.batchUpdate({
                documentId: documentId || "",
                requestBody: {
                    requests: [
                        {
                            insertText: {
                                location: {
                                    index: 1,
                                },
                                text: content,
                            },
                        },
                    ],
                },
            });
        }

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        documentId,
                        documentUrl: `https://docs.google.com/document/d/${documentId}/edit`,
                        title
                    })
                }
            ]
        };
    } catch (error) {
        console.error("Error creating document:", error);
        return textResult(`Error creating document: ${(error as any)?.message || error}`, true);
    }
}

export async function updateDoc(documentId: string, content: string, replaceAll: boolean = false): Promise<ToolResult> {
    const notReady = await ensureClients();
    if (notReady) return notReady;
    try {
        // Get the document structure
        const doc = await docsClient.documents.get({ documentId });
        const bodyContent = doc.data.body?.content;
        
        // Determine the end index of the document content
        // Subtract 1 because the endIndex is exclusive for deletion/insertion ranges
        const endIndex = bodyContent && bodyContent.length > 0 ? bodyContent[bodyContent.length - 1].endIndex! - 1 : 1;

        const requests: docs_v1.Schema$Request[] = [];

        if (replaceAll && endIndex > 1) { // Only delete if there is content
            // Add delete request
            requests.push({
                deleteContentRange: {
                    range: {
                        // Start index is always 1 for the beginning of the body
                        startIndex: 1, 
                        endIndex: endIndex,
                    },
                },
            });
        }

        // Add insert request (either at the beginning after deletion or at the end for appending)
        requests.push({
            insertText: {
                // If replacing all, insert at the beginning (index 1)
                // If appending, insert at the calculated end index
                location: {
                    index: replaceAll ? 1 : endIndex,
                },
                text: content,
            },
        });

        // Execute the batch update
        await docsClient.documents.batchUpdate({
            documentId,
            requestBody: {
                requests,
            },
        });

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        documentId,
                        documentUrl: `https://docs.google.com/document/d/${documentId}/edit`
                    })
                }
            ]
        };
    } catch (error) {
        console.error("Error updating document:", error);
        return textResult(`Error updating document: ${(error as any)?.message || error}`, true);
    }
}

export async function searchDocs(query: string): Promise<ToolResult> {
    const notReady = await ensureClients();
    if (notReady) return notReady;
    try {
        const response = await driveClient.files.list({
            q: `mimeType='application/vnd.google-apps.document' and fullText contains '${query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
            fields: "files(id, name, createdTime, modifiedTime)",
            pageSize: 10,
        });

        const files = response.data.files || [];
        let content = `Search results for "${query}":\n\n`;
        
        if (files.length === 0) {
            content += "No documents found matching your query.";
        } else {
            files.forEach((file: any) => {
                content += `Title: ${file.name}\n`;
                content += `ID: ${file.id}\n`;
                content += `Created: ${file.createdTime}\n`;
                content += `Last Modified: ${file.modifiedTime}\n\n`;
            });
        }

        return {
            content: [
                {
                    type: "text",
                    text: content
                }
            ]
        };
    } catch (error) {
        console.error("Error searching documents:", error);
        return textResult(`Error searching documents: ${(error as any)?.message || error}`, true);
    }
}

export async function deleteDoc(documentId: string): Promise<ToolResult> {
    const notReady = await ensureClients();
    if (notReady) return notReady;
    try {
        // Get the document title first for confirmation
        const doc = await docsClient.documents.get({ documentId });
        const title = doc.data.title;
        
        // Delete the document
        await driveClient.files.delete({
            fileId: documentId,
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Document "${title}" (ID: ${documentId}) has been successfully deleted.`
                }
            ]
        };
    } catch (error) {
        console.error(`Error deleting document ${documentId}:`, error);
        return textResult(`Error deleting document: ${(error as any)?.message || error}`, true);
    }
} 