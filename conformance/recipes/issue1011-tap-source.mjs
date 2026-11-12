/** Exact pinned shared helper AST, TypeScript types erased; original control flow retained. */
export async function tapElement(page, selector) {
    const element = await page.$(selector);
    if (!element) {
        throw new Error(`Failed to find tap element: ${selector}`);
    }
    async function fireTapLikeEvent(mode) {
        if (mode === 'tap') {
            await element.tap();
            return;
        }
        if (mode === 'trigger') {
            await element.trigger('tap');
            return;
        }
        if (mode === 'touch') {
            await element.touchstart();
            await element.touchend();
            return;
        }
        await element.dispatchEvent({ eventName: 'tap' });
    }
    let lastError;
    for (const mode of ['tap', 'trigger', 'touch', 'dispatch']) {
        try {
            await fireTapLikeEvent(mode);
            await page.waitFor(240);
            return;
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to tap element: ${selector}`);
}
