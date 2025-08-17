// ==UserScript==
// @name         Jenkins Gradle Test Command Generator
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Extract failed tests from Jenkins and generate Gradle command
// @author       Navaneeth Sen
// @match        https://ci.pega.io/*
// @match        https://jenkins.*/*
// @match        http://jenkins.*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        gradlePath: '../../gradlew',
        task: 'prpcTest',
        host: 'localhost',
        port: '18080',
        additionalFlags: '--rerun-tasks --info'
    };

    // CSS for the button and modal
    const styles = `
        .gradle-extractor-btn {
            background: #4CAF50;
            color: white;
            border: none;
            padding: 8px 16px;
            margin: 5px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: bold;
        }
        .gradle-extractor-btn:hover {
            background: #45a049;
        }
        .gradle-extractor-btn:disabled {
            background: #cccccc;
            cursor: not-allowed;
        }
        .gradle-modal {
            display: none;
            position: fixed;
            z-index: 10000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
        }
        .gradle-modal-content {
            background-color: #fefefe;
            margin: 5% auto;
            padding: 20px;
            border: 1px solid #888;
            width: 80%;
            max-width: 800px;
            border-radius: 8px;
            max-height: 80vh;
            overflow-y: auto;
        }
        .gradle-close {
            color: #aaa;
            float: right;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
        }
        .gradle-close:hover {
            color: black;
        }
        .gradle-command-box {
            background: #f4f4f4;
            border: 1px solid #ddd;
            padding: 10px;
            margin: 10px 0;
            border-radius: 4px;
            font-family: monospace;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .gradle-copy-btn {
            background: #2196F3;
            color: white;
            border: none;
            padding: 5px 10px;
            margin: 5px 0;
            border-radius: 4px;
            cursor: pointer;
        }
        .gradle-test-list {
            max-height: 200px;
            overflow-y: auto;
            border: 1px solid #ddd;
            padding: 10px;
            margin: 10px 0;
            background: #f9f9f9;
        }
    `;

    // Add styles to page
    function addStyles() {
        const styleSheet = document.createElement('style');
        styleSheet.textContent = styles;
        document.head.appendChild(styleSheet);
    }

    // Extract test names from various elements
    function extractFailedTests() {
        const failedTests = new Set();

        // Method 1: Look for test failure links in the main panel
        const testFailureSelectors = [
            '#main-panel table tbody tr td a[href*="testReport"]',
            'table tbody tr td a[href*="testReport"]',
            '.test-result a[href*="testReport"]'
        ];

        testFailureSelectors.forEach(selector => {
            const links = document.querySelectorAll(selector);
            links.forEach(link => {
                if (link.textContent.includes('failed') || link.textContent.includes('FAILED')) {
                    console.log('Found test failure link:', link.href);
                    // Try to extract from the link or navigate to get details
                }
            });
        });

        // Method 2: Look for specific test failure elements
        const testListSelectors = [
            '/html/body/div[4]/div[2]/table[1]/tbody/tr[8]/td[2]/ul/li',
            'table tbody tr td ul li',
            '.test-failures li',
            '[class*="test"] li'
        ];

        // Look for test failure elements - both visible and hidden
        const testElements = document.querySelectorAll('table tbody tr td ul li a, li.shown a, li.hidden a');
        testElements.forEach(link => {
            let testName = link.textContent.trim();
            // Take everything after the last '/'
            const lastSlashIndex = testName.lastIndexOf('/');
            if (lastSlashIndex !== -1) {
                testName = testName.substring(lastSlashIndex + 1).trim();
            }
            if (testName && testName.includes('.')) {
                failedTests.add(testName);
            }
        });

        // Method 3: Look in console output or test report pages
        if (window.location.href.includes('consoleText') || window.location.href.includes('testReport')) {
            const pageText = document.body.textContent;
            const testPatterns = [
                /Perform Validation \/ PRPC Tests \/ ([\w\.]+)/g,
                /([\w\.]+Test\.[\w]+)/g,
                /FAILED.*?([\w\.]+Test\.[\w]+)/g,
                /Test.*?([\w\.]+Test\.[\w]+).*?FAILED/g
            ];

            testPatterns.forEach(pattern => {
                let match;
                while ((match = pattern.exec(pageText)) !== null) {
                    const testName = match[1];
                    if (testName && testName.includes('.') && testName.includes('Test.')) {
                        failedTests.add(testName);
                    }
                }
            });
        }

        // Method 4: Try to fetch test report data if we're on a build page
        if (window.location.href.match(/\/\d+\/?$/)) {
            fetchTestReportData().then(tests => {
                tests.forEach(test => failedTests.add(test));
            });
        }

        return Array.from(failedTests);
    }

    // Fetch test report data via AJAX
    async function fetchTestReportData() {
        const failedTests = [];
        const baseUrl = window.location.href.split('#')[0].replace(/\/$/, '');

        try {
            // Try test report API
            const testReportUrl = `${baseUrl}/testReport/api/json`;
            const response = await fetch(testReportUrl);
            if (response.ok) {
                const data = await response.json();
                data.suites?.forEach(suite => {
                    suite.cases?.forEach(testCase => {
                        if (testCase.status === 'FAILED' || testCase.status === 'ERROR') {
                            const testName = `${testCase.className}.${testCase.name}`;
                            failedTests.push(testName);
                        }
                    });
                });
            }
        } catch (error) {
            console.log('Could not fetch test report data:', error);
        }

        try {
            // Try console output as fallback
            if (failedTests.length === 0) {
                const consoleUrl = `${baseUrl}/consoleText`;
                const response = await fetch(consoleUrl);
                if (response.ok) {
                    const text = await response.text();
                    const patterns = [
                        /Perform Validation \/ PRPC Tests \/ ([\w\.]+)/g,
                        /([\w\.]+Test\.[\w]+)/g,
                        /FAILED.*?([\w\.]+Test\.[\w]+)/g
                    ];

                    patterns.forEach(pattern => {
                        let match;
                        while ((match = pattern.exec(text)) !== null) {
                            const testName = match[1];
                            if (testName && testName.includes('.') && testName.includes('Test.')) {
                                failedTests.push(testName);
                            }
                        }
                    });
                }
            }
        } catch (error) {
            console.log('Could not fetch console output:', error);
        }

        return failedTests;
    }

    // Generate Gradle command
    function generateGradleCommand(testNames) {
        if (!testNames || testNames.length === 0) {
            return "# No failed tests found";
        }

        const uniqueTests = [...new Set(testNames)].sort();
        const testArgs = uniqueTests.map(test => `--tests "${test}"`).join(' ');

        return `${CONFIG.gradlePath} ${CONFIG.task} ${testArgs} -Dprpc.host=${CONFIG.host} -Dprpc.port=${CONFIG.port} ${CONFIG.additionalFlags}`;
    }

    // Show modal with results
    function showModal(tests, command) {
        const modal = document.createElement('div');
        modal.className = 'gradle-modal';
        modal.innerHTML = `
            <div class="gradle-modal-content">
                <span class="gradle-close">&times;</span>
                <h2>Gradle Test Command Generator</h2>

                <h3>Found ${tests.length} Failed Tests:</h3>
                <div class="gradle-test-list">
                    ${tests.length > 0 ? tests.map(test => `<div>• ${test}</div>`).join('') : '<div>No failed tests found</div>'}
                </div>

                <h3>Generated Gradle Command:</h3>
                <div class="gradle-command-box">${command}</div>

                <button class="gradle-copy-btn" onclick="navigator.clipboard.writeText('${command.replace(/'/g, "\\'")}').then(() => alert('Command copied to clipboard!'))">
                    Copy Command
                </button>

                <h3>Configuration:</h3>
                <div>
                    <label>Gradle Path: <input type="text" id="gradle-path" value="${CONFIG.gradlePath}" style="width: 200px;"></label><br><br>
                    <label>Host: <input type="text" id="gradle-host" value="${CONFIG.host}" style="width: 150px;"></label>
                    <label>Port: <input type="text" id="gradle-port" value="${CONFIG.port}" style="width: 80px;"></label><br><br>
                    <button class="gradle-copy-btn" onclick="updateConfig()">Update & Regenerate</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        // Close modal functionality
        const closeBtn = modal.querySelector('.gradle-close');
        closeBtn.onclick = () => {
            document.body.removeChild(modal);
        };

        modal.onclick = (event) => {
            if (event.target === modal) {
                document.body.removeChild(modal);
            }
        };

        // Update config function
        window.updateConfig = () => {
            CONFIG.gradlePath = document.getElementById('gradle-path').value;
            CONFIG.host = document.getElementById('gradle-host').value;
            CONFIG.port = document.getElementById('gradle-port').value;

            const newCommand = generateGradleCommand(tests);
            modal.querySelector('.gradle-command-box').textContent = newCommand;
            modal.querySelector('.gradle-copy-btn').onclick = () => {
                navigator.clipboard.writeText(newCommand).then(() => alert('Updated command copied to clipboard!'));
            };
        };
    }

    // Main function to extract tests and show results
    async function extractAndShowTests() {
        const button = document.getElementById('gradle-extractor-btn');
        button.disabled = true;
        button.textContent = 'Extracting...';

        try {
            // Get tests from page elements
            let tests = extractFailedTests();

            // If no tests found on page, try fetching from API
            if (tests.length === 0) {
                tests = await fetchTestReportData();
            }

            const command = generateGradleCommand(tests);
            showModal(tests, command);
        } catch (error) {
            alert('Error extracting tests: ' + error.message);
        } finally {
            button.disabled = false;
            button.textContent = 'Extract Failed Tests';
        }
    }

    // Check if we should show the button
    function shouldShowButton() {
        // Look for the Test Result link and check if it contains "(no failures)"
        const testResultLinks = document.querySelectorAll('a[href="testReport/"]');
        for (const link of testResultLinks) {
            const parentText = link.parentNode.textContent;
            if (parentText.includes('(no failures)')) {
                return false;
            }
        }

        // Also check for the pattern in any element containing "Test Result"
        const allLinks = document.querySelectorAll('a');
        for (const link of allLinks) {
            if (link.textContent.includes('Test Result') && link.parentNode.textContent.includes('(no failures)')) {
                return false;
            }
        }

        // Show on Jenkins build pages
        if (window.location.href.match(/\/\d+\/?(\#.*)?$/)) {
            return true;
        }

        // Show if there are test-related elements
        const testElements = document.querySelectorAll('a[href*="testReport"], .test-result, [class*="test"]');
        return testElements.length > 0;
    }

    // Add the extraction button
    function addExtractionButton() {
        // Check if button already exists to prevent duplicates
        if (document.getElementById('gradle-extractor-btn')) {
            return;
        }

        if (!shouldShowButton()) {
            return;
        }

        // Try to find a good place to add the button
        const targetSelectors = [
            '#main-panel h1',
            '#main-panel',
            '.build-caption',
            'h1',
            'body'
        ];

        let targetElement = null;
        for (const selector of targetSelectors) {
            targetElement = document.querySelector(selector);
            if (targetElement) break;
        }

        if (targetElement) {
            const button = document.createElement('button');
            button.id = 'gradle-extractor-btn';
            button.className = 'gradle-extractor-btn';
            button.textContent = 'Extract Failed Tests';
            button.onclick = extractAndShowTests;

            // Insert after the target element
            targetElement.parentNode.insertBefore(button, targetElement.nextSibling);
        }
    }

    // Initialize the script
    function init() {
        addStyles();

        // Add button immediately if page is already loaded
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', addExtractionButton);
        } else {
            addExtractionButton();
        }

        // Also try after a short delay in case content loads dynamically
        setTimeout(addExtractionButton, 2000);
    }

    // Start the script
    init();
})();
