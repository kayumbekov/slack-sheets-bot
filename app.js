// --- 1. Dependencies and Initialization ---
require('dotenv').config(); // Loads environment variables from a .env file locally
const { App, ExpressReceiver } = require('@slack/bolt');
const { google } = require('googleapis');
// Add these two lines at the top of app.js
const axios = require('axios');
const { PassThrough } = require('stream'); // Node.js built-in library for streaming

// --- 2. Heroku Configuration ---
// Heroku dynamically assigns a port, so we use process.env.PORT
const PORT = process.env.PORT || 3000;

// Initialize the Slack App
// Create a receiver without binding it to a port here. We'll start the
// app with the desired PORT below. This avoids double-binding issues.
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver,
});

// Expose a simple root route so visiting the Heroku app URL doesn't show "Cannot GET /".
// Also expose a health endpoint for uptime checks.
if (receiver && receiver.app) {
    receiver.app.get('/', (req, res) => {
        res.send('Slack Sheets Bot is running.');
    });

    receiver.app.get('/healthz', (req, res) => {
        res.status(200).send('OK');
    });
}

// Log basic info for incoming Slack requests so we can debug dispatch failures
if (receiver && receiver.app) {
    receiver.app.use((req, res, next) => {
        try {
            if (req.path && req.path.startsWith('/slack/')) {
                console.log('>>> Incoming Slack request:', req.method, req.path);
                console.log('    Slack headers:', {
                    'x-slack-signature': req.headers['x-slack-signature'],
                    'x-slack-request-timestamp': req.headers['x-slack-request-timestamp'],
                    host: req.headers.host,
                    'user-agent': req.headers['user-agent']
                });
            }
        } catch (err) {
            console.error('Error logging Slack request headers:', err && err.message ? err.message : err);
        }
        next();
    });
}

// --- 3. Google OAuth2 Client Setup (Keyless Auth) ---
// This client object will be used for both Sheets and Drive API calls.
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground' // Your redirect URI
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

// Initialize Google Services using the authenticated client
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// --- 4. Slash Command Handler: /return_claim ---
app.command('/return_claim', async ({ ack, body, client }) => {
    // Acknowledge the command immediately to avoid timeout
    await ack();

    try {
        // Open the Modal View
        const result = await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'return_claim_modal',
                title: { type: 'plain_text', text: 'File Return Claim' },
                submit: { type: 'plain_text', text: 'Submit Claim' },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'row_block',
                        label: { type: 'plain_text', text: 'Google Sheet Row Number' },
                        element: { type: 'plain_text_input', action_id: 'row_input', placeholder: { type: 'plain_text', text: 'e.g., 42' } },
                        hint: { type: 'plain_text', text: 'Used to identify the row to update.' }
                    },
                    {
                        type: 'input',
                        block_id: 'status_block',
                        label: { type: 'plain_text', text: 'New Item Status (Column L)' },
                        element: {
                            type: 'static_select',
                            action_id: 'status_input',
                            placeholder: { type: 'plain_text', text: 'Select Status...' },
                            options: [
                                { text: { type: 'plain_text', text: 'Back to Stock' }, value: 'Back to Stock' },
                                { text: { type: 'plain_text', text: 'Unsellable' }, value: 'Unsellable' },
                                { text: { type: 'plain_text', text: 'Needs Parts' }, value: 'Needs Parts' },
                                { text: { type: 'plain_text', text: 'Sellable open box' }, value: 'Sellable open box' }

                            ]
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'notes_block',
                        label: { type: 'plain_text', text: 'Notes / Text Message (Column N)' },
                        element: { type: 'plain_text_input', action_id: 'notes_input', multiline: true },
                        optional: true
                    },
                    {
                        type: 'input',
                        block_id: 'image_block',
                        label: { type: 'plain_text', text: 'Upload Image(s) (Max 5)' },
                        element: { type: 'file_input', action_id: 'image_input', filetypes: ['png', 'jpg', 'jpeg', 'gif'], max_files: 5 },
                        optional: true
                    }
                ]
            }
        });
        console.log('Modal opened successfully:', result.view.id);

    } catch (error) {
        console.error('Failed to open modal:', error);
    }
});

// Define this function anywhere in app.js BEFORE the app.view handler
/**
 * Handles the download of a single Slack file and uploads it to Google Drive.
 * @param {string} fileId - The Slack File ID (e.g., 'F012345').
 * @param {string} driveFolderId - The ID of the target Google Drive folder.
 * @returns {Promise<string>} The Google Drive Web View Link for the uploaded file.
 */
async function processFileClaim(fileId, driveFolderId) {
    try {
        // 1. Get Slack File Info (to get download URL and file name/type)
        const fileInfo = await app.client.files.info({ file: fileId });
        const slackFileUrl = fileInfo.file && (fileInfo.file.url_private_download || fileInfo.file.url_private);
        const fileName = (fileInfo.file && fileInfo.file.name) || `slack-file-${fileId}`;
        const mimeType = (fileInfo.file && fileInfo.file.mimetype) || 'application/octet-stream';

        if (!slackFileUrl) throw new Error(`No downloadable URL for Slack file ${fileId}`);

        // 2. Download the file from Slack (using the Bot Token for authorization)
        const slackResponse = await axios.get(slackFileUrl, {
            headers: {
                // CRITICAL: Must use the Bot Token for authorized download
                'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
            },
            responseType: 'stream' // We want the data as a stream
        });

        // 3. Upload the Stream to Google Drive
        const passThrough = new PassThrough();
        slackResponse.data.pipe(passThrough); // Pipe the incoming stream to the Passthrough stream

        const driveResult = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [driveFolderId],
                writersCanShare: true,
            },
            media: {
                mimeType: mimeType,
                body: passThrough,
            },
            fields: 'id, webViewLink, thumbnailLink'
        });

        // 4. Set the file to public (so the image formula works)
        if (driveResult && driveResult.data && driveResult.data.id) {
            await drive.permissions.create({
                fileId: driveResult.data.id,
                requestBody: {
                    role: 'reader',
                    type: 'anyone',
                },
            });

            // Return a direct link that Google Sheets =IMAGE can use.
            // webViewLink is a preview page; use the `uc?export=view&id=` pattern to embed images.
            const fileId = driveResult.data.id;
            const directImageUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
            return directImageUrl;
        }

        throw new Error('Failed to upload to Google Drive (no file id returned)');
    } catch (err) {
        console.error(`processFileClaim error for file ${fileId}:`, err && err.message ? err.message : err);
        throw err; // let the caller handle the error
    }
}





// --- 5. Modal Submission Handler ---
app.view('return_claim_modal', async ({ ack, body, view, client }) => {
    // 5a. Acknowledge the submission immediately
    await ack();

    // 5b. Extract the submitted values
    const user = body.user.id;
    const values = view.state.values;

    // Defensive extractor — blocks or actions may be missing/optional
    const getField = (blockId, actionId) => (values && values[blockId] && values[blockId][actionId]) ? values[blockId][actionId] : null;

    // Data Extraction (with safe fallbacks)
    const rowNumberRaw = getField('row_block', 'row_input') && getField('row_block', 'row_input').value;
    const rowNumber = rowNumberRaw ? String(rowNumberRaw).trim() : null;

    const newStatus = getField('status_block', 'status_input') && getField('status_block', 'status_input').selected_option && getField('status_block', 'status_input').selected_option.value || '';

    const notesText = getField('notes_block', 'notes_input') && getField('notes_block', 'notes_input').value || '';

    // Note: Slack modal file inputs are not always available in view.state; guard against missing data.
    const rawImageField = getField('image_block', 'image_input');
    const imageFiles = (rawImageField && Array.isArray(rawImageField.files)) ? rawImageField.files : [];

    // 5c. Start the Asynchronous Google Logic
    try {
    console.log(`Processing claim for Row: ${rowNumber || '[missing]'} . Files count: ${imageFiles.length}`);

        // --- 🔑 PLACEHOLDER FOR CORE LOGIC: Google Drive & Sheets Update ---
        
        const uploadedUrls = []; // This will hold the Drive URLs after upload
        const driveFolderId = '1pAkEignCWb-Aoy4oCHKsiJSN5Tcee09S'; // <--- IMPORTANT: Verify your Drive folder ID

        if (imageFiles.length > 0) {
            // Only process entries that have an `id` property
            const validFiles = imageFiles.filter(f => f && f.id).map(f => f.id);
            if (validFiles.length > 0) {
                const uploadPromises = validFiles.map(fid => processFileClaim(fid, driveFolderId));
                const allUrls = await Promise.all(uploadPromises);
                uploadedUrls.push(...allUrls);
            }
        }
        

        // --- Sheet Update Logic ---
       // --- Sheet Update Logic ---
const SHEET_ID = '1frYc-OnrqaA2M1Tkf2fTLzYX2Ncb0dQHLdCEPV1V7cs'; // <--- IMPORTANT: Update this
const targetRow = rowNumber;

// The first URL is used for the thumbnail in Column O.
// We'll store the other URLs in Columns P, Q, R, S.
const firstImageUrl = uploadedUrls[0] || '';
const imageFormula = firstImageUrl ? `=IMAGE("${firstImageUrl}", 1)` : ''; 

// We need an array for the remaining 4 images (or less) to go into P, Q, R, S
const remainingImageUrls = uploadedUrls.slice(1);
const fillColumns = remainingImageUrls.concat(Array(4).fill('')); // Ensure we always send 4 values (padding with blank strings)

// 5d. Send the batch update to Google Sheets (Columns L, N, O, P, Q, R, S)
// L: Status, M: Blank (Original), N: Notes, O: Image Formula
// P, Q, R, S: Remaining Image Links
const updateRange = `Amazon!L${targetRow}:S${targetRow}`; 
        
await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: updateRange,
    valueInputOption: 'USER_ENTERED', // Use 'USER_ENTERED' for formulas
    resource: {
        values: [
            [newStatus, '', notesText, imageFormula, ...fillColumns.slice(0, 4)]
        ],
    },
});
        
        // --- 5e. Post a Final Confirmation Message ---
        await client.chat.postMessage({
            channel: user, // Direct message the user
            text: `✅ Claim successfully processed for Row ${rowNumber || '[unknown]'}!\nStatus: ${newStatus}\nNotes: ${notesText ? 'Updated' : 'None'}\nImages: ${uploadedUrls.length} uploaded`,
        });

    } catch (error) {
        console.error('FATAL ERROR during claim submission:', error);
        // Post an error message to the user
        await client.chat.postMessage({
            channel: user,
            text: `❌ ERROR: Your claim could not be processed for Row ${rowNumber}. Please check the server logs for details.`,
        });
    }
});

// --- 6. Start the App ---
(async () => {
    await app.start(PORT);
    console.log(`⚡️ Bolt app is running on port ${PORT}!`);
})();

// Global error handlers to ensure uncaught exceptions/rejections are logged to Heroku logs
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err && err.stack ? err.stack : err);
    // Do not exit immediately on Heroku; let the platform restart if needed.
});

// --- 7. Reminder for Heroku Config Vars ---
// Reminder: set these environment variables on Heroku (and locally in .env). Do NOT commit secrets to source control.
// Required Slack envs: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
// Required Google envs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN