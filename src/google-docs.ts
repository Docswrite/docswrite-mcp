import { google } from "googleapis";
import { docs_v1, drive_v3 } from "googleapis";
import { authorize } from "./auth.js";

interface ContentResponse {
    [key: string]: unknown;
    type: "text";
    text: string;
}

let docsClient: docs_v1.Docs;
let driveClient: drive_v3.Drive;

// Initialize Google API clients
export async function initClients() {
    try {
        console.error("Starting client initialization...");
        const auth = await authorize();
        console.error("Auth completed successfully:", !!auth);
        docsClient = google.docs({ version: "v1", auth: auth as any });
        console.error("Docs client created:", !!docsClient);
        driveClient = google.drive({ version: "v3", auth: auth as any });
        console.error("Drive client created:", !!driveClient);
        return true;
    } catch (error) {
        console.error("Failed to initialize Google API clients:", error);
        return false;
    }
}

export async function createDoc(title: string, content: string = ""): Promise<{ content: ContentResponse[] }> {
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
        return {
            content: [
                {
                    type: "text",
                    text: `Error creating document: ${error}`
                }
            ]
        };
    }
}

export async function updateDoc(documentId: string, content: string, replaceAll: boolean = false): Promise<{ content: ContentResponse[] }> {
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
        return {
            content: [
                {
                    type: "text",
                    text: `Error updating document: ${error}`
                }
            ]
        };
    }
}

export async function searchDocs(query: string): Promise<{ content: ContentResponse[] }> {
    try {
        const response = await driveClient.files.list({
            q: `mimeType='application/vnd.google-apps.document' and fullText contains '${query}'`,
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
        return {
            content: [
                {
                    type: "text",
                    text: `Error searching documents: ${error}`
                }
            ]
        };
    }
}

export async function deleteDoc(documentId: string): Promise<{ content: ContentResponse[] }> {
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
        return {
            content: [
                {
                    type: "text",
                    text: `Error deleting document: ${error}`
                }
            ]
        };
    }
} 