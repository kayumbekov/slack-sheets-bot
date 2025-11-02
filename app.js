// --- 1. Dependencies and Initialization ---
require('dotenv').config(); // Loads environment variables from a .env file locally
const { App } = require('@slack/bolt');
const { google } = require('googleapis');

// --- 2. Heroku Configuration ---
// Heroku dynamically assigns a port, so we use process.env.PORT
const PORT = process.env.PORT || 3000;

// Initialize the Slack App
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    // When running on Heroku, Bolt needs to know the process.env.PORT
    // 'receiver' handles the web server aspects (like routing and listening)
    receiver: new (require('@slack/bolt').ExpressReceiver)({
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        port: PORT
    })
});

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

// --- 5. Modal Submission Handler ---
app.view('return_claim_modal', async ({ ack, body, view, client }) => {
    // 5a. Acknowledge the submission immediately
    await ack();

    // 5b. Extract the submitted values
    const user = body.user.id;
    const values = view.state.values;

    // Use a simple function to pull the value from the complex Slack structure
    const getFieldValue = (blockId, actionId) => values[blockId][actionId];

    // Data Extraction
    const rowNumber = getFieldValue('row_block', 'row_input').value;
    const newStatus = getFieldValue('status_block', 'status_input').selected_option.value;
    const notesText = getFieldValue('notes_block', 'notes_input').value;
    const imageFiles = getFieldValue('image_block', 'image_input').files || []; // Array of { id: 'F...', ...}

    // 5c. Start the Asynchronous Google Logic
    try {
        console.log(`Processing claim for Row: ${rowNumber}. Files count: ${imageFiles.length}`);

        // --- 🔑 PLACEHOLDER FOR CORE LOGIC: Google Drive & Sheets Update ---
        
        const uploadedUrls = []; // This will hold the Drive URLs after upload
        
        if (imageFiles.length > 0) {
            // STEP 1: Loop through imageFiles, call Slack files.info, download file.
            // STEP 2: Upload file data to Google Drive using the 'drive' client.
            // STEP 3: Store the publicly accessible URL/formula in uploadedUrls.
            
            // This is the most complex part and will be our next step!
            
            uploadedUrls.push('URL_OF_FIRST_IMAGE'); // Placeholder for first image
            // Other URLs go into columns P, Q, R, S, or into the cell's note.
        }

        // --- Sheet Update Logic ---
        const SHEET_ID = 'YOUR_GOOGLE_SHEET_ID_HERE'; // <--- IMPORTANT: Update this
        const targetRow = rowNumber;
        const driveFolderId = '1pAkEignCWb-Aoy4oCHKsiJSN5Tcee09S'; // Your Drive folder ID

        // Create the IMAGE formula for the first image
        const imageFormula = uploadedUrls.length > 0
            ? `=IMAGE("${uploadedUrls[0]}", 1)` // 1 means fitting the cell
            : ''; 

        // 5d. Send the batch update to Google Sheets (Columns L, N, O)
        const updateRange = `Amazon!L${targetRow}:O${targetRow}`; // Column L, N, O in row X
        
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: updateRange,
            valueInputOption: 'USER_ENTERED', // Use 'USER_ENTERED' for formulas
            resource: {
                values: [
                    [newStatus, '', notesText, imageFormula] // L, M(blank), N, O
                ],
            },
        });
        
        // --- 5e. Post a Final Confirmation Message ---
        await client.chat.postMessage({
            channel: body.user.id, // Direct message the user
            text: `✅ Claim successfully processed for **Row ${rowNumber}**!
            *Status:* ${newStatus} (L${rowNumber})
            *Notes:* Updated (N${rowNumber})
            *Images:* ${imageFiles.length} uploaded to Drive and Sheet (O${rowNumber})`
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

// --- 7. Reminder for Heroku Config Vars ---
// Remember to set these two Slack variables on Heroku (in addition to the three Google ones):
// SLACK_BOT_TOKEN
// SLACK_SIGNING_SECRET