// --- 1. Dependencies and Initialization ---
require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { google } = require('googleapis');
const axios = require('axios');
const { PassThrough } = require('stream');
const express = require('express'); // Import express
const http = require('http'); // Import http

// --- 2. Application Configuration ---
const PORT = process.env.PORT || 3000;

const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    processBeforeResponse: true, // Required for custom body parsing
});

// Manually add the urlencoded body parser that Slack needs
receiver.app.use(express.urlencoded({ extended: true }));

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver,
});

// Remove the custom logging middleware, as it can interfere with body parsing.
// Bolt will log errors automatically.

// --- 3. Google OAuth2 Client Setup ---
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground' // Redirect URI
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

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
    const imageFiles = view.files || [];

    if (!rowNumber) {
        await client.chat.postMessage({ channel: user, text: '❌ Error: Row number is required.' });
        return;
    }

    try {
        const driveFolderId = '1pAkEignCWb-Aoy4oCHKsiJSN5Tcee09S'; // IMPORTANT: Your Google Drive Folder ID
        const uploadPromises = imageFiles.map(file => processAndUploadFile(file.id, driveFolderId));
        const uploadedUrls = await Promise.all(uploadPromises);

        const firstImageUrl = uploadedUrls[0] || '';
        const imageFormula = firstImageUrl ? `=IMAGE("${firstImageUrl}", 1)` : '';
        const remainingImageUrls = uploadedUrls.slice(1, 5);
        const fillColumns = remainingImageUrls.concat(Array(4 - remainingImageUrls.length).fill(''));

        const SHEET_ID = '1frYc-OnrqaA2M1Tkf2fTLzYX2Ncb0dQHLdCEPV1V7cs'; // IMPORTANT: Your Google Sheet ID
        const updateRange = `Amazon!L${rowNumber}:S${rowNumber}`;

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
receiver.app.get('/', (req, res) => res.send('Slack Sheets Bot is running.'));
receiver.app.get('/healthz', (req, res) => res.status(200).send('OK'));

// (async () => {
//     await app.start(PORT);
//     console.log(`⚡️ Bolt app is running on port ${PORT}`);
// })();

// Use a standard HTTP server setup for better compatibility
const server = http.createServer(receiver.app);

server.listen(PORT, () => {
    console.log(`⚡️ Bolt app is running on port ${PORT}`);
});