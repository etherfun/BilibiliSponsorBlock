import Config from "../config";

export { DynamicListener };

async function DynamicListener() {
    const parentElement = document.querySelector('main') || document.querySelector('.s-space');
    if (!parentElement) {
        setTimeout(DynamicListener, 50);
        return;
    }
    if (!((window.location.href.includes('t.bilibili.com') && Config.config.dynamicAdBlocker)
        || (window.location.href.includes('space.bilibili.com') && Config.config.dynamicSpaceAdBlocker))
    ) return;

    const observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.type !== 'childList') continue;
            const element = Array.from(mutation.addedNodes).find((node) =>
                node.nodeType === Node.ELEMENT_NODE
                && (node as Element).nodeName === 'DIV'
                && (node as Element).classList.contains('bili-dyn-list__item')
            ) as HTMLElement | undefined;
            if (!element) continue;

            const goodsElement = element.querySelector('.bili-dyn-card-goods');
            const goodsElementOrigin = element?.querySelector('.bili-dyn-card-goods.hide-border');
            if (!goodsElement) continue;
            const bodyElement = element.querySelector('.bili-dyn-item__body') as HTMLElement;
            
            const upId = element.querySelector('.bili-dyn-item__avatar').getAttribute('bilisponsor-userid')
            //转发动态的原UP主
            const upIdOrigin = element?.querySelector('.dyn-orig-author__face')?.getAttribute('bilisponsor-userid')
            if (!(Config.config.whitelistedChannels.includes(upId)
                || Config.config.whitelistedChannels.includes(upIdOrigin))
                || Config.config.dynamicAdWhitelistedChannels
            ) {
                bodyElement.style.display = 'none';

                const toggleButton = getButton();
                toggleButton.textContent = chrome.i18n.getMessage('dynamicAdShow');
                toggleButton.insertBefore(getIcon(), toggleButton.firstChild);
                toggleButton.addEventListener('click', () => {
                    if (bodyElement.style.display === 'none') {
                        bodyElement.style.display = 'block';
    
                        toggleButton.textContent = chrome.i18n.getMessage('dynamicAdHide');
                        toggleButton.insertBefore(getIcon(), toggleButton.firstChild);
                    } else {
                        bodyElement.style.display = 'none';
    
                        toggleButton.textContent = chrome.i18n.getMessage('dynamicAdShow');
                        toggleButton.insertBefore(getIcon(), toggleButton.firstChild);
                    }
                });
    
                element.querySelector('.bili-dyn-item__footer').appendChild(toggleButton);
            }
            const sponsorDynamic = document.createElement('div') as HTMLElement;
            sponsorDynamic.id = 'sponsorDynamicLabel'

            sponsorDynamic.appendChild(getIcon());

            const sponsorDynamicText = document.createElement('span') as HTMLElement;
            if (goodsElementOrigin) {
                sponsorDynamicText.textContent = chrome.i18n.getMessage('category_forward_sponsor');

                sponsorDynamic.style.setProperty(
                    "--category-color",
                    `var(--sb-category-preview-selfpromo, var(--sb-category-selfpromo))`
                );
                sponsorDynamic.style.setProperty(
                    "--category-text-color",
                    `#fff`
                );
            } else {
                sponsorDynamicText.textContent = chrome.i18n.getMessage('category_sponsor');

                sponsorDynamic.style.setProperty(
                    "--category-color",
                    `var(--sb-category-preview-sponsor, var(--sb-category-sponsor))`
                );
                sponsorDynamic.style.setProperty(
                    "--category-text-color",
                    `#fff`
                );
            }
            sponsorDynamic.appendChild(sponsorDynamicText);

            sponsorDynamic.addEventListener('mouseenter', () => {
                sponsorDynamicText.style.display = 'block';
                sponsorDynamic.style.borderRadius = '0.5em'
            });
            sponsorDynamic.addEventListener('mouseleave', () => {
                sponsorDynamicText.style.display = 'none';
                sponsorDynamic.style.borderRadius = '2em'
            });

            element.querySelector('.bili-dyn-title').appendChild(sponsorDynamic);
        }
    })
    observer.observe(parentElement, { childList: true, subtree: true });
}

function getIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 568 568");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#SponsorBlockIcon");
    svg.appendChild(use);
    return svg
}

function getButton() {
    const toggleButton = document.createElement('button');
    toggleButton.id = 'showSponsorDynamic';
    toggleButton.className = 'bili-dyn-action';
    return toggleButton;
}