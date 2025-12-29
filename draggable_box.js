// ==UserScript==
// @name         DraggableBox
// @namespace    https://example.com
// @version      1.4
// @description  Icons that show a lazily-created draggable box on hover, hide on unhover, toggle permanent show/hide on click, properly execute <script> tags, and fix drag offset/text selection issues.
// @match        *://*.cardmarket.com/*
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /**
     * A WeakMap to store per-icon state:
     *   iconElement => {
     *     box:                  The DOM element (draggable box)
     *     header:               The DOM element (header for dragging)
     *     isCreated:            Boolean if the box is already created
     *     isPermanentlyShown:   Boolean if the box is 'locked' open
     *     isDown:               Boolean if we are actively dragging
     *     offsetX, offsetY:     Number offset for dragging
     *   }
     */
    const iconMap = new WeakMap();

    /**
     * Takes a parent element, finds all <script> tags, and re-injects them
     * so that they execute. This is necessary because setting innerHTML
     * or appending nodes containing <script> tags will not automatically
     * run those scripts.
     *
     * @param {HTMLElement} parent The parent element containing any <script> tags.
     */
    function adoptScripts(parent) {
        const scripts = parent.querySelectorAll('script');
        scripts.forEach((oldScript) => {
            const newScript = document.createElement('script');

            // Copy over type
            if (oldScript.type) {
                newScript.type = oldScript.type;
            }

            // Copy src or inline script
            if (oldScript.src) {
                newScript.src = oldScript.src;
            } else {
                newScript.textContent = oldScript.textContent;
            }

            // Insert the new script so it executes
            parent.appendChild(newScript);

            // Remove the old (non-executed) script
            oldScript.remove();
        });
    }

    /**
     * Attach a draggable box to an icon element.
     *
     * On first hover or click, the box is created and any <script> tags
     * in the contentElement are executed. On subsequent hovers/clicks,
     * the same box is just shown/hidden.
     *
     * @param {HTMLElement} iconElement    The icon that triggers the box.
     * @param {HTMLElement} contentElement The DOM element (or fragment) to place in the box.
     *                                     May include <script> tags that will be executed.
     */
    function attachDraggableBoxIcon(iconElement, contentElement, title = 'Chart') {
        // If already attached, do nothing
        if (iconMap.has(iconElement)) {
            return;
        }

        // Initialize the icon’s data
        const data = {
            box: null,
            header: null,
            isCreated: false,
            isPermanentlyShown: false,
            isDown: false,
            offsetX: 0,
            offsetY: 0
        };
        iconMap.set(iconElement, data);

        // Lazily create the box on demand
        function createBox() {
            data.isCreated = true;

            // Main box
            const box = document.createElement('div');
            box.style.position = 'absolute';
            box.style.width = '500px';
            box.style.height = '250px';
            // Lower z-index so it can slide under a site header with higher z-index
            box.style.zIndex = 900;
            box.style.backgroundColor = 'var(--bs-body-bg)';
            box.style.color = 'var(--bs-body-color)';
            box.style.border = '1px solid var(--bs-border-color)';
            box.style.display = 'none';    // Hidden by default

            // Header (draggable area)
            const header = document.createElement('div');
            header.style.backgroundColor = 'var(--bs-tertiary-bg)';
            header.style.color = 'var(--bs-body-color)';
            header.style.padding = '2px 2px 2px 5px';
            header.style.borderBottom = '1px solid var(--bs-border-color)';
            header.style.cursor = 'move';
            header.style.fontSize = 'small';
            header.innerHTML = `<strong>${title}</strong>`;

            // Wrap the user-provided content
            const contentWrapper = document.createElement('div');
            contentWrapper.style.padding = '10px';
            contentWrapper.style.height = '90%';
            contentWrapper.appendChild(contentElement);

            contentElement.style.height = '100%';

            // Adopt <script> tags so they execute
            adoptScripts(contentWrapper);

            // Put the pieces together
            box.appendChild(header);
            box.appendChild(contentWrapper);
            document.body.appendChild(box);

            // Save references
            data.box = box;
            data.header = header;

            // Draggable logic: only by header
            header.addEventListener('mousedown', (e) => {
                e.preventDefault();  // Prevent selecting text or dragging images
                data.isDown = true;
                // Compute offset using pageX/pageY
                data.offsetX = e.pageX - box.offsetLeft;
                data.offsetY = e.pageY - box.offsetTop;

                // Optionally disable text selection on entire page while dragging
                document.body.style.userSelect = 'none';
            });

            document.addEventListener('mousemove', (e) => {
                if (!data.isDown) return;
                e.preventDefault(); // Prevent text selection while moving
                box.style.left = (e.pageX - data.offsetX) + 'px';
                box.style.top  = (e.pageY - data.offsetY) + 'px';
            });

            document.addEventListener('mouseup', () => {
                data.isDown = false;
                // Re-enable text selection
                document.body.style.userSelect = '';
            });
        }

        // Show the box near the icon
        function showBox() {
            if (!data.box) return;
            // Position the box near the icon
            const rect = iconElement.getBoundingClientRect();
            data.box.style.top = `${rect.bottom + window.scrollY + 5}px`;
            data.box.style.left = `${rect.left + window.scrollX}px`;
            data.box.style.display = 'block';
        }

        // Hide the box
        function hideBox() {
            if (!data.box) return;
            data.box.style.display = 'none';
        }

        // Event handlers
        function onMouseEnter() {
            if (!data.isPermanentlyShown) {
                if (!data.isCreated) createBox();
                showBox();
            }
        }
        function onMouseLeave() {
            if (!data.isPermanentlyShown) {
                hideBox();
            }
        }
        function onClick() {
            data.isPermanentlyShown = !data.isPermanentlyShown;
            if (data.isPermanentlyShown) {
                if (!data.isCreated) createBox();
                showBox();
            } else {
                hideBox();
            }
        }

        // Attach listeners
        iconElement.addEventListener('mouseenter', onMouseEnter);
        iconElement.addEventListener('mouseleave', onMouseLeave);
        iconElement.addEventListener('click', onClick);
    }

    // Expose the function so you can call it from the console or your own scripts.
    unsafeWindow.attachDraggableBoxIcon = attachDraggableBoxIcon;
})();
