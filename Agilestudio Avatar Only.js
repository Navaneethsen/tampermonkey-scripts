// ==UserScript==
// @name         AgileStudio - Avatar Only
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Show only avatar in the user presence div, remove text and resize
// @author       Navaneeth Sen
// @match        https://agilestudio.pega.com/prweb/AgileStudio/app/agilestudio/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    function cleanupAvatarDiv() {
        // Find all avatar divs with data-testid=":avatar:"
        const allAvatars = document.querySelectorAll('div[data-testid=":avatar:"][role="img"]');

        if (allAvatars.length === 0) {
            return false;
        }

        // Find the notification container by looking for text "is viewing" or "collaborator"
        let notificationContainer = null;
        let avatarParent = null;
        let avatarContainers = [];

        for (const avatar of allAvatars) {
            const parent = avatar.parentElement;
            if (!parent) continue;

            const grandParent = parent.parentElement;
            if (!grandParent) continue;

            // Check if grandparent contains notification text
            const grandParentText = grandParent.textContent || '';
            const isNotification = grandParentText.includes('is viewing') ||
                                  grandParentText.includes('collaborator') ||
                                  grandParent.querySelector('[data-testid=":count:"]');

            if (isNotification) {
                notificationContainer = grandParent;
                avatarParent = parent;
                // Get all avatars in this parent - use children instead of querySelectorAll
                avatarContainers = Array.from(parent.children).filter(child =>
                    child.getAttribute('data-testid') === ':avatar:' &&
                    child.getAttribute('role') === 'img'
                );
                console.log('[AgileStudio Avatar] Found notification with', avatarContainers.length, 'avatar(s)');
                avatarContainers.forEach((a, i) => {
                    console.log('[AgileStudio Avatar] Avatar', i + 1, ':', a.getAttribute('aria-label'));
                });
                break;
            }
        }

        if (!notificationContainer || !avatarParent || avatarContainers.length === 0) {
            return false;
        }

        // Hide non-avatar children with CSS (don't touch text nodes to avoid React conflicts)
        Array.from(notificationContainer.children).forEach(child => {
            if (child !== avatarParent) {
                child.style.setProperty('display', 'none', 'important');
                child.style.setProperty('visibility', 'hidden', 'important');
                child.style.setProperty('position', 'absolute', 'important');
                child.style.setProperty('width', '0', 'important');
                child.style.setProperty('height', '0', 'important');
                child.style.setProperty('overflow', 'hidden', 'important');
            }
        });

        // Hide text using CSS on the container - set font-size to 0
        notificationContainer.style.setProperty('font-size', '0', 'important');
        notificationContainer.style.setProperty('line-height', '0', 'important');
        notificationContainer.style.setProperty('color', 'transparent', 'important');

        // Style the notification container to be compact and positioned in bottom right
        notificationContainer.style.setProperty('position', 'fixed', 'important');
        notificationContainer.style.setProperty('bottom', '20px', 'important');
        notificationContainer.style.setProperty('right', '20px', 'important');
        notificationContainer.style.setProperty('left', 'auto', 'important');
        notificationContainer.style.setProperty('top', 'auto', 'important');
        notificationContainer.style.setProperty('transform', 'none', 'important');
        notificationContainer.style.setProperty('min-height', 'auto', 'important');
        notificationContainer.style.setProperty('height', 'auto', 'important');
        notificationContainer.style.setProperty('width', 'fit-content', 'important');
        notificationContainer.style.setProperty('max-width', 'none', 'important');
        notificationContainer.style.setProperty('padding', '8px', 'important');
        notificationContainer.style.setProperty('display', 'flex', 'important');
        notificationContainer.style.setProperty('flex-wrap', 'nowrap', 'important');
        notificationContainer.style.setProperty('align-items', 'center', 'important');
        notificationContainer.style.setProperty('justify-content', 'center', 'important');
        notificationContainer.style.setProperty('z-index', '99999', 'important');
        notificationContainer.style.setProperty('margin', '0', 'important');
        notificationContainer.style.setProperty('background', 'transparent', 'important');
        notificationContainer.style.setProperty('background-color', 'transparent', 'important');
        notificationContainer.style.setProperty('backdrop-filter', 'none', 'important');
        notificationContainer.style.setProperty('box-shadow', 'none', 'important');
        notificationContainer.style.setProperty('border', 'none', 'important');
        notificationContainer.style.setProperty('border-radius', '0', 'important');

        // Determine if we should use overlapping style (more than 3 avatars)
        const shouldOverlap = avatarContainers.length > 3;

        if (shouldOverlap) {
            // Style for overlapping avatars (like a pack of CDs)
            // Expand leftward to avoid going out of bounds
            avatarParent.style.setProperty('display', 'flex', 'important');
            avatarParent.style.setProperty('flex-direction', 'row', 'important');
            avatarParent.style.setProperty('position', 'relative', 'important');
            avatarParent.style.setProperty('align-items', 'center', 'important');
            avatarParent.style.setProperty('margin', '0', 'important');
            avatarParent.style.setProperty('padding', '0', 'important');
            avatarParent.style.setProperty('width', 'auto', 'important');
            avatarParent.style.setProperty('height', 'auto', 'important');

        } else {
            // Style for normal display (3 or fewer avatars)
            avatarParent.style.setProperty('display', 'flex', 'important');
            avatarParent.style.setProperty('flex-direction', 'row', 'important');
            avatarParent.style.setProperty('flex-wrap', 'nowrap', 'important');
            avatarParent.style.setProperty('gap', '6px', 'important');
            avatarParent.style.setProperty('align-items', 'center', 'important');
            avatarParent.style.setProperty('justify-content', 'flex-start', 'important');
            avatarParent.style.setProperty('margin', '0', 'important');
            avatarParent.style.setProperty('padding', '0', 'important');
            avatarParent.style.setProperty('width', 'auto', 'important');
            avatarParent.style.setProperty('max-width', 'none', 'important');
        }

        // Collect all names for hover tooltip
        const names = avatarContainers.map(avatar =>
            avatar.getAttribute('aria-label') || 'Unknown'
        );
        const tooltipText = names.join(', ');

        // Add title attribute for hover tooltip
        notificationContainer.setAttribute('title', tooltipText);
        avatarParent.setAttribute('title', tooltipText);

        // Style each avatar container
        avatarContainers.forEach((avatarContainer, index) => {
            console.log('Styling avatar', index + 1);

            // Add tooltip to each avatar as well
            const avatarName = avatarContainer.getAttribute('aria-label') || 'Unknown';
            avatarContainer.setAttribute('title', tooltipText);

            if (shouldOverlap) {
                // Overlapping style - use negative margin to overlap leftward
                // Each avatar overlaps the previous by 80% (showing 20%)
                const overlapAmount = index === 0 ? '0' : '-20px'; // 50% of ~40px avatar
                avatarContainer.style.setProperty('margin-left', overlapAmount, 'important');
                avatarContainer.style.setProperty('margin-right', '0', 'important');
                avatarContainer.style.setProperty('margin-top', '0', 'important');
                avatarContainer.style.setProperty('margin-bottom', '0', 'important');
                avatarContainer.style.setProperty('padding', '0', 'important');
                avatarContainer.style.setProperty('display', 'inline-flex', 'important');
                avatarContainer.style.setProperty('visibility', 'visible', 'important');
                avatarContainer.style.setProperty('opacity', '1', 'important');
                avatarContainer.style.setProperty('z-index', `${index}`, 'important');
                avatarContainer.style.setProperty('cursor', 'pointer', 'important');
                avatarContainer.style.setProperty('position', 'relative', 'important');
            } else {
                // Normal style - side by side
                avatarContainer.style.setProperty('margin', '0', 'important');
                avatarContainer.style.setProperty('padding', '0', 'important');
                avatarContainer.style.setProperty('display', 'inline-flex', 'important');
                avatarContainer.style.setProperty('visibility', 'visible', 'important');
                avatarContainer.style.setProperty('opacity', '1', 'important');
                avatarContainer.style.setProperty('flex-shrink', '0', 'important');
                avatarContainer.style.setProperty('cursor', 'pointer', 'important');
            }

            // Find and style the avatar image
            const avatarImg = avatarContainer.querySelector('img');
            if (avatarImg) {
                avatarImg.style.setProperty('margin', '0', 'important');
                avatarImg.style.setProperty('padding', '0', 'important');
                avatarImg.style.setProperty('display', 'block', 'important');
                avatarImg.style.setProperty('visibility', 'visible', 'important');
                avatarImg.style.setProperty('opacity', '1', 'important');
            }
        });

        return true;
    }

    // Run the cleanup function
    function init() {
        // Try to clean up immediately
        if (cleanupAvatarDiv()) {
            console.log('Avatar cleanup successful');
        } else {
            console.log('Avatar not found, will retry...');
        }
    }

    // Wait for page to be fully loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Use MutationObserver to handle dynamic content
    const observer = new MutationObserver((mutations) => {
        cleanupAvatarDiv();
    });

    // Start observing the document with the configured parameters
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Also run periodically for the first few seconds in case content loads dynamically
    let attempts = 0;
    const maxAttempts = 10;
    const initialInterval = setInterval(() => {
        cleanupAvatarDiv();
        attempts++;
        if (attempts >= maxAttempts) {
            clearInterval(initialInterval);
        }
    }, 500);

    // Refresh every 10 seconds to update avatars
    setInterval(() => {
        console.log('[AgileStudio Avatar] Running periodic refresh...');
        cleanupAvatarDiv();
    }, 10000);

})();
