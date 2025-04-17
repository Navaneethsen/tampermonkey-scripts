// ==UserScript==
// @name         WebEx Video and Transcript Downloader
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Download videos and transcripts from WebEx recordings
// @author       navaneethsen@gmail.com using claudeai
// @match        *://*.webex.com/webappng/site/*
// @match        *://*.webex.com/recordingservice/sites/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      *.webex.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // URL pattern matching for WebEx recordings
    const REGEX = /^https?:\/\/(.+?)\.webex\.com\/(?:recordingservice|webappng)\/sites\/([^\/]+)\/.*?([a-f0-9]{32})[^\?]*(\?.*)?/;

    // Global variables to store recording information
    let recordingParams = null;
    let downloadPassword = null;
    let apiResponse = null;

    // Main initialization function
    function init() {
        // Check if we're on a WebEx recording page
        const match = REGEX.exec(window.location.href);
        if (!match) {
            console.log("Not a WebEx recording page, script not running");
            return;
        }

        // Extract parameters from the URL
        const subdomain = match[1];
        const sitename = match[2];
        const recordingId = match[3];
        const authParams = match[4] || '';

        recordingParams = { subdomain, sitename, recordingId, authParams };

        // Start observing DOM changes to detect when the player loads
        observePlayerLoading();

        // Try to intercept network requests to get password
        interceptPasswordRequests();

        // Log successful initialization
        console.log("WebEx Downloader initialized for recording:", recordingId);
    }

    // Create a MutationObserver to detect when the player is loaded
    function observePlayerLoading() {
        const observer = new MutationObserver((mutations) => {
            // Check if player elements are loaded
            const playerExists = document.querySelector('.wxp-player') ||
                               document.querySelector('video') ||
                               document.querySelector('.ngplayer') ||
                               document.querySelector('.recordingTitle');

            if (playerExists) {
                console.log("WebEx player detected, fetching recording info");
                fetchRecordingInfo();
                observer.disconnect();
            }
        });

        // Start observing the DOM
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Try to intercept network requests to extract password
    function interceptPasswordRequests() {
        // Create a wrapper for the native fetch function
        const originalFetch = window.fetch;
        window.fetch = function(url, options) {
            // Check if this is a request to the recordings API
            if (url.toString().includes('/api/v1/recordings/')) {
                // Try to extract password from headers
                if (options && options.headers) {
                    if (options.headers.accessPwd) {
                        downloadPassword = options.headers.accessPwd;
                        console.log("Password intercepted from fetch request");
                    }
                }
            }

            // Call the original fetch function
            return originalFetch.apply(this, arguments);
        };

        // Also intercept XMLHttpRequest for older WebEx sites
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (url.toString().includes('/api/v1/recordings/')) {
                // Listen for setRequestHeader calls to capture the password
                const originalSetHeader = this.setRequestHeader;
                this.setRequestHeader = function(header, value) {
                    if (header === 'accessPwd') {
                        downloadPassword = value;
                        console.log("Password intercepted from XHR request");
                    }
                    return originalSetHeader.apply(this, arguments);
                };
            }
            return originalXhrOpen.apply(this, arguments);
        };
    }

    // Fetch recording information from the WebEx API
    function fetchRecordingInfo() {
        if (!recordingParams) return;

        // Construct the API URL
        const apiUrl = `https://${recordingParams.subdomain}.webex.com/webappng/api/v1/recordings/${recordingParams.recordingId}/stream${recordingParams.authParams}`;

        // Set up headers for the request
        const headers = {
            "Accept": "application/json, text/plain, */*"
        };

        // Add password if we have it
        if (downloadPassword) {
            headers.accessPwd = downloadPassword;
        } else {
            headers.appFrom = "pb";
        }

        // Make the API request
        GM_xmlhttpRequest({
            method: "GET",
            url: apiUrl,
            headers: headers,
            onload: function(response) {
                try {
                    // Parse the JSON response
                    apiResponse = JSON.parse(response.responseText);

                    // Process the response and add buttons
                    processApiResponse(apiResponse);
                } catch (error) {
                    console.error("Error processing WebEx API response:", error);
                }
            },
            onerror: function(error) {
                console.error("Error fetching WebEx recording info:", error);
            }
        });
    }

    // Process the API response and add download buttons
    function processApiResponse(response) {
        if (!response) {
            console.error("Empty API response");
            return;
        }

        try {
            // Parse necessary parameters from the response
            const params = parseParametersFromResponse(response);

            // Add download buttons to the page
            addDownloadButtons(params);
        } catch (error) {
            console.error("Error parsing WebEx API response:", error);
        }
    }

    // Parse parameters from the API response
    function parseParametersFromResponse(response) {
        const params = {};

        // Get the record name for the filename
        params.recordName = response.recordName || "webex_recording";

        // Handle direct download URL if available
        if (response.fallbackPlaySrc) {
            params.downloadUrl = response.fallbackPlaySrc;
        }

        // Handle stream options for older recordings
        if (response.mp4StreamOption) {
            const streamOption = response.mp4StreamOption;

            // Copy all properties that might be needed
            params.host = streamOption.host;
            params.recordingDir = streamOption.recordingDir;
            params.timestamp = streamOption.timestamp;
            params.token = streamOption.token;
            params.xmlName = streamOption.xmlName;
            params.playbackOption = streamOption.playbackOption;

            // New format parameters (May 2022+)
            params.siteid = streamOption.siteid;
            params.recordid = streamOption.recordid;
            params.islogin = streamOption.islogin;
            params.isprevent = streamOption.isprevent;
            params.ispwd = streamOption.ispwd;
        }

        // If we don't have a direct download URL, construct one
        if (!params.downloadUrl) {
            params.downloadUrl = constructDownloadUrl(params);
        }

        return params;
    }

    // Construct download URL from parameters
    function constructDownloadUrl(params) {
        // Recordings before May 2022
        if (params.recordingDir !== undefined) {
            const url = new URL("apis/html5-pipeline.do", params.host);
            url.searchParams.set("recordingDir", params.recordingDir);
            url.searchParams.set("timestamp", params.timestamp);
            url.searchParams.set("token", params.token);
            url.searchParams.set("xmlName", params.xmlName);
            url.searchParams.set("isMobileOrTablet", "false");
            url.searchParams.set("ext", params.playbackOption);

            return url.toString();
        }
        // Recordings from May 2022
        else if (params.siteid !== undefined) {
            const url = new URL("nbr/MultiThreadDownloadServlet/recording.xml", params.host);
            url.searchParams.set("siteid", params.siteid);
            url.searchParams.set("recordid", params.recordid);
            url.searchParams.set("ticket", params.token);
            url.searchParams.set("timestamp", params.timestamp);
            url.searchParams.set("islogin", params.islogin);
            url.searchParams.set("isprevent", params.isprevent);
            url.searchParams.set("ispwd", params.ispwd);
            url.searchParams.set("play", "1");

            return url.toString();
        }

        return null;
    }

    // Add download buttons to the WebEx player interface
    function addDownloadButtons(params) {
        // Check if buttons already exist
        if (document.getElementById('webex-download-container')) {
            return;
        }

        // Create container for buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'webex-download-container';
        buttonContainer.style.position = 'absolute';
        buttonContainer.style.top = '10px';
        buttonContainer.style.right = '10px';
        buttonContainer.style.zIndex = '9999';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.flexDirection = 'column';
        buttonContainer.style.gap = '8px';

        // Create video download button
        if (params.downloadUrl) {
            const videoButton = createButton('Download Video', 'webex-video-download-btn');
            videoButton.addEventListener('click', () => downloadVideo(params));
            buttonContainer.appendChild(videoButton);
        }

        // Create transcript download button if transcript exists
        if (document.querySelector('.wxp-transcript-list') ||
            document.querySelector('.wxp-panel-list') ||
            document.querySelector('[aria-labelledby="wxp-transcript-tab"]')) {

            const transcriptButton = createButton('Download Transcript', 'webex-transcript-download-btn');
            transcriptButton.addEventListener('click', downloadTranscript);
            buttonContainer.appendChild(transcriptButton);
        }

        // Find appropriate container for the buttons
        let container = document.querySelector('.wxp-player-container') ||
                       document.querySelector('.ngPlayerContainer') ||
                       document.querySelector('#wrapper') ||
                       document.querySelector('.recordingHeader') ||
                       document.querySelector('.video-container');

        if (container) {
            container.style.position = 'relative';
            container.appendChild(buttonContainer);
        } else {
            // Fallback to body
            buttonContainer.style.position = 'fixed';
            buttonContainer.style.top = '80px';
            buttonContainer.style.right = '20px';
            document.body.appendChild(buttonContainer);
        }

        console.log("WebEx download buttons added successfully");
    }

    // Helper function to create a styled button
    function createButton(text, id) {
        const button = document.createElement('button');
        button.textContent = text;
        button.id = id;
        button.style.padding = '8px 16px';
        button.style.backgroundColor = '#00ab6c'; // WebEx green
        button.style.color = 'white';
        button.style.border = 'none';
        button.style.borderRadius = '4px';
        button.style.cursor = 'pointer';
        button.style.fontFamily = 'CiscoSansTT, Arial, sans-serif';
        button.style.fontSize = '14px';
        button.style.fontWeight = 'bold';
        button.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
        button.style.width = '100%';

        // Add hover effect
        button.onmouseover = function() {
            this.style.backgroundColor = '#008f5b';
        };
        button.onmouseout = function() {
            this.style.backgroundColor = '#00ab6c';
        };

        return button;
    }

    // Function to download the video
    function downloadVideo(params) {
        // Sanitize the filename
        const filename = sanitizeFilename(params.recordName) + '.mp4';

        // Attempt to download using GM_download
        if (typeof GM_download !== 'undefined') {
            try {
                GM_download({
                    url: params.downloadUrl,
                    name: filename,
                    onload: () => console.log('Video download started'),
                    onerror: (e) => {
                        console.error('GM_download failed:', e);
                        fallbackDownload(params.downloadUrl, filename);
                    }
                });
                return;
            } catch (e) {
                console.error('Error using GM_download:', e);
            }
        }

        // Use fallback method if GM_download fails or isn't available
        fallbackDownload(params.downloadUrl, filename);
    }

    // Fallback download method
    function fallbackDownload(url, filename) {
        try {
            // Create and trigger a download link
            const downloadLink = document.createElement('a');
            downloadLink.href = url;
            downloadLink.download = filename;
            downloadLink.style.display = 'none';
            document.body.appendChild(downloadLink);

            downloadLink.click();

            // Clean up
            setTimeout(() => {
                document.body.removeChild(downloadLink);
            }, 100);
        } catch (e) {
            console.error('Error creating download link:', e);

            // Open in new tab as last resort
            alert('Direct download failed. Opening in new tab. Right-click and select "Save as" to download.');
            window.open(url, '_blank');
        }
    }

    // Function to download the transcript
    function downloadTranscript() {
        // Get all transcript cue elements
        const cueElements = document.querySelectorAll('.wxp-transcript-item');

        if (!cueElements || cueElements.length === 0) {
            alert('No transcript found on this page.');
            return;
        }

        let transcriptText = '';
        let currentSpeaker = '';

        // Extract text from each cue element
        cueElements.forEach((cue) => {
            try {
                // Extract the text content
                let cueText = cue.textContent.trim();

                // Check if there's speaker info
                const speakerMatch = cueText.match(/^(.*?):\s*(.*)/);
                let speaker = '';
                let text = cueText;

                if (speakerMatch && speakerMatch.length > 2) {
                    speaker = speakerMatch[1].trim();
                    text = speakerMatch[2].trim();

                    // Only add speaker name when it changes
                    if (speaker !== currentSpeaker) {
                        transcriptText += `\n${speaker}:\n`;
                        currentSpeaker = speaker;
                    }

                    transcriptText += `${text}\n`;
                } else {
                    // No speaker info, just add the text
                    transcriptText += `${cueText}\n`;
                }
            } catch (e) {
                // Fallback if any error occurs in parsing
                transcriptText += `${cue.textContent.trim()}\n`;
            }
        });

        // Clean up any double newlines
        transcriptText = transcriptText.replace(/\n\n+/g, '\n\n');

        // Get recording name if available
        let fileName = 'webex_transcript.txt';
        if (apiResponse && apiResponse.recordName) {
            fileName = `${sanitizeFilename(apiResponse.recordName)}_transcript.txt`;
        } else {
            // Try to get name from page title
            const titleElement = document.querySelector('.meeting-title') ||
                               document.querySelector('.recording-title') ||
                               document.querySelector('title');

            if (titleElement && titleElement.textContent) {
                fileName = `${sanitizeFilename(titleElement.textContent)}_transcript.txt`;
            }
        }

        // Create blob for download
        const blob = new Blob([transcriptText], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);

        // Create download link
        const downloadLink = document.createElement('a');
        downloadLink.href = url;
        downloadLink.download = fileName;

        // Trigger download
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);

        // Clean up
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 100);
    }

    // Helper function to sanitize filenames
    function sanitizeFilename(filename) {
        if (!filename) return "webex_recording";
        return filename.replace(/[^\w\s\d\-_~,;\[\]\(\).]/g, "_");
    }

    // Initialize the script
    setTimeout(init, 1000);
})();