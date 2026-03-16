import fs from 'fs';
import { RenderedEmail } from '../types';

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * Replaces {{key}} placeholders in a template with values from the map.
 * Values are HTML-escaped to prevent injection in email HTML bodies.
 * Unmatched placeholders are replaced with empty string.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = variables[key];
    return value !== undefined ? escapeHtml(value) : '';
  });
}

/**
 * Renders both HTML and plain-text versions for multipart/alternative.
 */
export function renderMultipart(
  template: string,
  variables: Record<string, string>,
): RenderedEmail {
  const html = renderTemplate(template, variables);
  const text = htmlToPlainText(html);
  return { html, text };
}

/**
 * Renders a raw message body (no template) into multipart.
 */
export function bodyToMultipart(body: string): RenderedEmail {
  // If body looks like HTML, generate plain-text from it
  if (/<[a-z][\s\S]*>/i.test(body)) {
    return { html: body, text: htmlToPlainText(body) };
  }
  // Plain text input — wrap in minimal HTML
  const escaped = escapeHtml(body);
  return {
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6">${escaped.replace(/\n/g, '<br>')}</div>`,
    text: body,
  };
}

export function loadTemplate(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Template file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Converts HTML to readable plain text. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
