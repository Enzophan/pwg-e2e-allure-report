import { test, expect } from "@playwright/test";

test("verify title of dev.to", async ({ page }) => {
  await page.goto("https://dev.to");

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/DEV Community/);
});

test("verify description of dev.to", async ({ page }) => {
  await page.goto("https://dev.to");

  // Expect a description meta tag to have content.
  const description = await page
    .locator('head > meta[name="description"]')
    .getAttribute("content");
  expect(description).toBeTruthy();
});

test("verify DEV Challenges of dev.to", async ({ page }) => {
  await page.goto("https://dev.to");

  // Expect a description meta tag to have content.
  await page
    .locator(".side-bar > nav > ul.default-navigation-links > li")
    .getByText("DEV Challenges")
    .click();

  await expect(page.locator("section > h1")).toHaveText("Join a DEV Online Hackathon or Writing Challenge");
  expect(page.url()).toBe("https://dev.to/challenges");
});
