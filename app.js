// --- 1. Dependencies and Initialization ---
require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt'); // Re-add ExpressReceiver
const { google } = require('googleapis');
const axios = require('axios');
const { PassThrough } = require('stream');
const http = require('http'); // Import http

// --- 1a. Validate required environment variables (logs only; does not crash) ---
(function validateRequiredEnv() {
    const required = [
        'SLACK_BOT_TOKEN',
        'SLACK_SIGNING_SECRET',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'GOOGLE_REFRESH_TOKEN'
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
        console.error('Missing required environment variables:', missing.join(', '));
        console.error('Set them via Heroku config:set KEY=VALUE before using Google APIs.');
    }
})();

// --- 2. Application Configuration ---
const PORT = process.env.PORT || 3000;

// Create a receiver
const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    endpoints: {
        commands: '/slack/commands',
        actions: '/slack/actions',
        events: '/slack/events',
        options: '/slack/options'
    }
});

// Initialize the app with the receiver
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver,
});

// --- 3. Google OAuth2 Client Setup ---
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground' // Redirect URI
);

// Ensure we at least attach the refresh token when available
oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

// Helper to proactively verify Google auth can obtain an access token
async function ensureGoogleAuthReady() {
    try {
        // Throws if refresh token is missing/invalid
        const token = await oauth2Client.getAccessToken();
        if (!token || !token.token) {
            console.error('Google OAuth: received empty access token.');
            return false;
        }
        return true;
    } catch (e) {
        console.error('Google OAuth access token fetch failed:', e && e.message ? e.message : e);
        return false;
    }
}

// Initialize Google Drive and Sheets APIs
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// Explicit targets
const SHEET_ID = '1frYc-OnrqaA2M1Tkf2fTLzYX2Ncb0dQHLdCEPV1V7cs';
const SHEET_NAME = 'Amazon';

// Helper: verify the target tab exists
async function ensureSheetExists(spreadsheetId, sheetName) {
    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets.properties.title'
        });
        const titles = (meta.data.sheets || []).map(s => s.properties.title);
        const exists = titles.includes(sheetName);
        if (!exists) {
            console.error(`Sheet tab "${sheetName}" not found. Available tabs: ${titles.join(', ')}`);
        }
        return { exists, titles };
    } catch (e) {
        console.error('Failed to fetch spreadsheet metadata:', e && e.message ? e.message : e);
        return { exists: false, titles: [] };
    }
}

// --- 4. Helper Function: Process and Upload File ---
async function processAndUploadFile(fileId, driveFolderId) {
    try {
        const fileInfo = await app.client.files.info({ file: fileId });
        if (!fileInfo.ok || !fileInfo.file) {
            throw new Error(`Could not get file info for ${fileId}`);
        }

        const slackFileUrl = fileInfo.file.url_private_download;
        const fileName = fileInfo.file.name || `slack-file-${fileId}`;
        const mimeType = fileInfo.file.mimetype || 'application/octet-stream';

        if (!slackFileUrl) {
            throw new Error(`No downloadable URL for Slack file ${fileId}`);
        }

        const slackResponse = await axios.get(slackFileUrl, {
            headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            responseType: 'stream',
        });

        const passThrough = new PassThrough();
        slackResponse.data.pipe(passThrough);

        const driveResult = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [driveFolderId],
            },
            media: {
                mimeType: mimeType,
                body: passThrough,
            },
            fields: 'id',
        });

        const driveFileId = driveResult.data.id;
        if (!driveFileId) {
            throw new Error('File upload to Drive did not return an ID.');
        }

        await drive.permissions.create({
            fileId: driveFileId,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });

        return `https://drive.google.com/uc?export=view&id=${driveFileId}`;
    } catch (error) {
        console.error(`Error processing file ${fileId}:`, error.message);
        throw error;
    }
}

// --- 5. Slack Command Handler: /return_claim ---
app.command('/return_claim', async ({ ack, body, client }) => {
    await ack();
    try {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'return_claim_modal',
                title: { type: 'plain_text', text: 'File Return Claim' },
                submit: { type: 'plain_text', text: 'Submit' },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'row_block',
                        label: { type: 'plain_text', text: 'Sheet Row Number' },
                        element: { type: 'plain_text_input', action_id: 'row_input', placeholder: { type: 'plain_text', text: 'e.g., 42' } },
                    },
                    {
                        type: 'input',
                        block_id: 'status_block',
                        label: { type: 'plain_text', text: 'New Item Status' },
                        element: {
                            type: 'static_select',
                            action_id: 'status_input',
                            placeholder: { type: 'plain_text', text: 'Select Status' },
                            options: [
                                { text: { type: 'plain_text', text: 'Back to Stock' }, value: 'Back to Stock' },
                                { text: { type: 'plain_text', text: 'Unsellable' }, value: 'Unsellable' },
                                { text: { type: 'plain_text', text: 'Needs Parts' }, value: 'Needs Parts' },
                                { text: { type: 'plain_text', text: 'Sellable open box' }, value: 'Sellable open box' },
                            ],
                        },
                    },
                    {
                        type: 'input',
                        block_id: 'notes_block',
                        label: { type: 'plain_text', text: 'Notes' },
                        element: { type: 'plain_text_input', action_id: 'notes_input', multiline: true },
                        optional: true,
                    },
                    {
                        type: 'input',
                        block_id: 'image_block',
                        label: { type: 'plain_text', text: 'Upload Image(s) (Max 5)' },
                        element: { type: 'file_input', action_id: 'image_input', filetypes: ['png', 'jpg', 'jpeg', 'gif'], max_files: 5 },
                        optional: true,
                    },
                ],
            },
        });
    } catch (error) {
        console.error('Failed to open modal:', error);
    }
});

// --- 6. Slack View Submission Handler ---
app.view('return_claim_modal', async ({ ack, body, view, client }) => {
    await ack();

    const user = body.user.id;
    const values = view.state.values;

    const rowNumber = values.row_block.row_input.value?.trim();
    const newStatus = values.status_block.status_input.selected_option?.value || '';
    const notesText = values.notes_block.notes_input.value || '';

    // Prefer file IDs from file_input.selected_files
    const fileInputEl = values?.image_block?.image_input;
    const selectedFileIds = Array.isArray(fileInputEl?.selected_files) ? fileInputEl.selected_files : [];
    console.log('Selected file IDs from file_input:', selectedFileIds);

    if (!rowNumber) {
        await client.chat.postMessage({ channel: user, text: '❌ Error: Row number is required.' });
        return;
    }

    try {
        const googleReady = await ensureGoogleAuthReady();
        if (!googleReady) {
            await client.chat.postMessage({
                channel: user,
                text: '❌ Google authorization is not configured. An admin must set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN on Heroku (heroku config:set ...).'
            });
            return;
        }

        const { exists, titles } = await ensureSheetExists(SHEET_ID, SHEET_NAME);
        if (!exists) {
            await client.chat.postMessage({
                channel: user,
                text: `❌ Sheet tab "${SHEET_NAME}" not found. Available tabs: ${titles.join(', ') || '[none]'}.`
            });
            return;
        }

        const driveFolderId = '1pAkEignCWb-Aoy4oCHKsiJSN5Tcee09S';
        const uploadedUrls = [];

        if (selectedFileIds.length > 0) {
            const uploadPromises = selectedFileIds.map(fid => processAndUploadFile(fid, driveFolderId));
            const allUrls = await Promise.all(uploadPromises);
            uploadedUrls.push(...allUrls);
        }

        const firstImageUrl = uploadedUrls[0] || '';
        const imageFormula = firstImageUrl ? `=IMAGE("${firstImageUrl}", 1)` : '';
        const remainingImageUrls = uploadedUrls.slice(1, 5);
        const fillColumns = remainingImageUrls.concat(Array(4 - remainingImageUrls.length).fill(''));

        const updateRange = `${SHEET_NAME}!L${rowNumber}:S${rowNumber}`;

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: updateRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[newStatus, '', notesText, imageFormula, ...fillColumns]],
            },
        });

        await client.chat.postMessage({
            channel: user,
            text: `✅ Claim successfully processed for Row ${rowNumber}!\nImages uploaded: ${uploadedUrls.length}`,
        });
    } catch (error) {
        console.error('Error during claim submission:', error);
        await client.chat.postMessage({
            channel: user,
            text: `❌ ERROR: Your claim for Row ${rowNumber} failed. Please contact an administrator.`,
        });
    }
});

// --- 7. Health Check and Start App ---
// Add custom routes to the receiver's express app
receiver.app.get('/', (req, res) => res.send('Slack Sheets Bot is running.'));
receiver.app.get('/healthz', (req, res) => res.status(200).send('OK'));

(async () => {
    // Use the receiver's app to create a server and start it
    const server = http.createServer(receiver.app);
    server.listen(PORT, () => {
        console.log(`⚡️ Bolt app is running on port ${PORT}`);
    });
})();