'use strict';

const assert = require('assert');
const util = require('util');
const Tokenizer = require('../lib/tokenizer');
const LocationInfoTokenizerMixin = require('../lib/extensions/location-info/tokenizer-mixin');
const Mixin = require('../lib/utils/mixin');
const { getSubstringByLineCol, normalizeNewLine, addSlashes } = require('../../../test/utils/common');

const MODE = Tokenizer.MODE;

const NULL_REFS = ['&#0;', '&#x00;'];
const NULL = ['\u0000'];

const NBSP_REFS = ['&nbsp;', '&#160;', '&#xA0;'];
const NBSP = [...NBSP_REFS, '\u00A0'];

const TAB_REFS = ['&Tab;', '&#9;', '&#x9;'];
const NEWLINE_REFS = ['&NewLine;', '&#10;', '&#xA;'];
const FORMFEED_REFS = ['&#12;', '&#xC;'];
const SPACE_REFS = ['&#32;', '&#x20;'];

const WHITESPACE_REFS = [...TAB_REFS, ...NEWLINE_REFS, ...FORMFEED_REFS, ...SPACE_REFS];
const WHITESPACE_CHARS = ['\t', '\n', '\f', ' '];
const WHITESPACE = [...WHITESPACE_CHARS, ...WHITESPACE_REFS];

/* helpers: array massaging */

function crossProduct(arr1, arr2) {
    const res = [];
    for (const a of arr1) {
        for (const b of arr2) {
            res.push([a, b]);
        }
    }
    res.flatten = flatten;
    return res;
}

function flatten() {
    return this.reduce((acc, elem) => acc.concat(elem), []);
}

/* Test cases: {
 *     [description: string]: [
 *          initialMode: Tokenizer.MODE,
 *          lastStartTagName: string,
 *          htmlChunks: [string|[string]]
 *      ]
 * }
 * To skip a particular test, just prefix `description` with `//`; it'll be marked as 'TODO:...'.
 * `htmlChunks` defines both, the input text and the expected tokens together
 * with their locations.
 * - the input text is simply all the chunks concatenated together 
 *   (if a chunk is itself an array, *its* elements get concatenated first)
 * - each chunk corresponds to exactly one token that the tokenizer is expected
 *   to emit.
 *   * string chunks: expected location is calculated from length (and previous chunks)
 *   * array chunks: these imply an expected START_TAG_TOKEN, which has additional
 *     location info for attributes.
 *     1. element must be the "<" plus the tagName and all whitespace up to the first attr name
 *     then one element per attribute (name, "=" and value) plus any trailing whitespace
 *     last element must be the ">" or "/>"
 *     Example:
 *     the fragment '<div id="foo" class="bar">' is expected to yield a START_TAG_TOKEN
 *     with two attributes.
 *     -> ['<div ', 'id="foo" ', 'class="bar"', '>']
 */

const testCases = {
    'complete document': [
        MODE.DATA,
        '',
        [
            '\r\n',
            '<!DOCTYPE html>',
            '\n',
            '<!-- Test -->',
            '\n',
            '<head>',
            '\n   ',
            ['<meta ', 'charset="utf-8"', '>'],
            '<title>',
            '   ',
            'node.js',
            '\u0000',
            '</title>',
            '\n',
            '</head>',
            '\n',
            ['<body ', 'id="front"', '>'],
            '\n',
            ['<div ', 'id="intro"', '>'],
            '\n   ',
            '<p\n>',
            '\n       ',
            'Node.js',
            ' ',
            'is',
            ' ',
            'a',
            '\n       ',
            'platform',
            ' ',
            'built',
            ' ',
            'on',
            '\n       ',
            ['<a ', 'href="http://code.google.com/p/v8/"', '>'],
            '\n       ',
            "Chrome's",
            ' ',
            'JavaScript',
            ' ',
            'runtime',
            '\n       ',
            '</a>',
            '\n',
            '</div>',
            '</body>'
        ]
    ],
    'from inside <title>': [MODE.RCDATA, 'title', ['<div>Test', ' \n   ', 'hey', ' ', 'ya!', '</title>', '<!--Yo-->']],
    'inside <style>': [
        MODE.RAWTEXT,
        'style',
        ['.header{', ' \n   ', 'color:red;', '\n', '}', '</style>', 'Some', ' ', 'text']
    ],
    'inside <script>': [
        MODE.SCRIPT_DATA,
        'script',
        ['var', ' ', 'a=c', ' ', '-', ' ', 'd;', '\n', 'a<--d;', '</script>', '<div>']
    ],
    'after <plaintext>': [MODE.PLAINTEXT, 'plaintext', ['Text', ' \n', 'Test</plaintext><div>']],
    'one attribute': [MODE.DATA, 'body', [['<div ', 'id1="foo"', '>'], ['<div ', "id2='single-quoted'", '>']]],
    'one attribute, unquoted': [
        MODE.DATA,
        'body',
        [
            ['<div ', 'id=foo', '>'],
            ['<div ', 'id =foo', '>'],
            ['<div ', 'id= foo', '>'],
            ['<div ', 'id = foo', '>'],
            ['<div\n', 'id = foo', '>']
        ]
    ],
    'one attribute without value': [MODE.DATA, 'body', [['<div ', 'id', '>']]],
    'two attributes with intermediate whitespace': [
        MODE.DATA,
        'body',
        [
            ['<div ', 'id="foo" ', 'class="bar"', '>'],
            ['<div ', "id2='single-quoted' ", "class='bar'", '>'],
            ['<div ', "id3 = 'single-quoted' ", "class= 'bar'", '>']
        ]
    ],
    'two attributes with newlines in between': [
        MODE.DATA,
        'body',
        [
            ['<div\n     ', 'id="foo"\n     ', 'class="bar"', '>'],
            ['<div\n     ', "id2='single-quoted'\n     ", "class='bar'", '>'],
            ['<div\n     ', "id3 = 'single-quoted'\n     ", "class= 'bar'", '>']
        ]
    ],
    'two attributes with no whitespace in between': [
        MODE.DATA,
        'body',
        [
            ['<div ', 'id ="foo"', 'class="bar"', '>'],
            ['<div ', "id2='single-quoted'", "class='bar'", '>'],
            ['<div ', "id3=   'single-quoted'", "class= 'bar'", '>'][
                ('<div ', "id4  = 'single-quoted'", "class= 'bar'", '>')
            ]
        ]
    ],
    'non-whitespace char-ref after plain whitespace': [
        MODE.DATA,
        'body',
        crossProduct(WHITESPACE_CHARS, ['&lt;', '&#60;', '&#x60;']).flatten()
    ],
    'non-whitespace char-ref after whitespace char-ref': [
        MODE.DATA,
        'body',
        crossProduct(WHITESPACE_REFS, ['&lt;', '&#60;', '&#x60;']).flatten()
    ],
    'non-breaking-space after whitespace': [MODE.DATA, 'body', crossProduct(WHITESPACE, NBSP).flatten()],
    'non-breaking-space char-ref after \\u0000': [MODE.DATA, 'body', crossProduct(['\u0000'], NBSP_REFS).flatten()],
    'non-breaking-space character after \\u0000': [MODE.DATA, 'body', ['\u0000', '\u00A0']],
    'non-breaking-space after non-whitespace': [
        MODE.DATA,
        'body',
        [
            crossProduct(['foo', '_', '&gt;'], NBSP)
                .flatten()
                .join('')
        ]
    ],
    'whitespace char-ref after whitespace': [
        MODE.DATA,
        'body',
        [
            crossProduct(WHITESPACE, WHITESPACE_REFS)
                .flatten()
                .join('')
        ]
    ],
    'whitespace char-ref after non-whitespace': [
        MODE.DATA,
        'body',
        [
            crossProduct(['foo', '&not_a_char_ref;'], WHITESPACE_REFS)
                .flatten()
                .join('')
        ]
    ],
    'whitespace char-ref after non-whitespace char-ref': [
        MODE.DATA,
        'body',
        [
            crossProduct(['&nbsp;', '&lt;', '&#60;', '&#x60;'], WHITESPACE_REFS)
                .flatten()
                .join('')
        ]
    ],
    'non-whitespace char-ref after non-whitespace': [
        MODE.DATA,
        'body',
        [
            crossProduct(['foo', '_', '&gt;'], ['&lt;', '#60;', '&x3C;'])
                .flatten()
                .join('')
        ]
    ]
};

class ExpectedLocation {
    constructor() {
        this.startLine = 1;
        this.startCol = 1;
        this.startOffset = 0;
        this.endLine = 1;
        this.endCol = 1;
        this.endOffset = 0;
    }
    createCopy() {
        return Object.assign(new ExpectedLocation(), this);
    }
    update(srcChunk) {
        this.startOffset = this.endOffset;
        this.endOffset += srcChunk.length;
        // The \n itself - emitted as (part of) a WHITESPACE_CHARACTER_TOKEN - is considered
        // the very last character of a line, and the new line starts right after it.
        // Therefore the next token's startLine is the previous token's endLine,
        // and likewise for startCol and endCol.
        this.startLine = this.endLine;
        this.startCol = this.endCol;
        // For endLine and endCol, we take the simplest approach possible:
        for (const ch of srcChunk) {
            if (ch === '\n') {
                this.endCol = 1;
                this.endLine++;
            } else {
                this.endCol++;
            }
        }
        return this;
    }
}

for (const [description, [initialMode, lastStartTagName, htmlChunks]] of Object.entries(testCases)) {
    const testIdx = Object.keys(exports).length;
    let testName = `Location info (Tokenizer) ${testIdx}` + ` - [${initialMode}/${lastStartTagName}]`;
    if (description.startsWith('//')) {
        testName = 'TODO: ' + testName + ' ' + description.substring(2).trim();
        exports[testName] = () => assert.ok(true);
    } else {
        testName += ' ' + description;
        // exports[testName] = mkTest(initialMode, lastStartTagName, htmlChunks);
        exports[testName] = () => {
            const tokenizer = new Tokenizer();

            Mixin.install(tokenizer, LocationInfoTokenizerMixin);

            htmlChunks.forEach(chunk => tokenizer.write(Array.isArray(chunk) ? chunk.join('') : chunk, false));
            tokenizer.write('', true);

            // NOTE: set small waterline for testing purposes
            tokenizer.preprocessor.bufferWaterline = 8;
            tokenizer.state = initialMode;
            tokenizer.lastStartTagName = lastStartTagName;

            let exp = new ExpectedLocation();

            let nextToken = tokenizer.getNextToken();
            let j = 0;
            while (nextToken.type !== Tokenizer.EOF_TOKEN) {
                let currentToken = nextToken;
                nextToken = tokenizer.getNextToken();
                if (currentToken.type === Tokenizer.HIBERNATION_TOKEN) {
                    continue;
                }

                let srcChunk = htmlChunks[j++];

                delete exp.attrs;

                // array chunk means: START_TAG_TOKEN expected
                if (Array.isArray(srcChunk)) {
                    const attrs = {};
                    // "<", tagName and whitespace up till first attr at index 0
                    let c = srcChunk[0],
                        attrLoc = exp.createCopy().update(c);
                    for (let k = 1; k < srcChunk.length - 1; k++) {
                        c = srcChunk[k];
                        const i = c.indexOf('=');
                        const attrName = c.substring(0, i < 0 ? c.length : i).trim();
                        attrs[attrName] = attrLoc.createCopy().update(c.trim());
                        attrLoc.update(c); // now with trailing whitespace
                    }
                    exp.attrs = attrs;
                    srcChunk = srcChunk.join('');
                }
                exp.update(srcChunk);

                let msg = `location @ source chunk #${j - 1}`;
                msg += `\nchunk #${j - 1}: '${addSlashes(srcChunk)}'`;
                msg += `\ntoken #${j - 1}: ${util.inspect(currentToken, { depth: 3 })}\n`;
                msg += `\nchunk #${j}: `;
                if (j == htmlChunks.length) {
                    msg += '-';
                } else if (Array.isArray(htmlChunks[j])) {
                    msg += `['${htmlChunks[j].map(addSlashes).join("', '")}']`;
                } else {
                    msg += `'${addSlashes(htmlChunks[j])}'`;
                }
                msg += `\ntoken #${j}: ${util.inspect(nextToken, { depth: 3 })}\n`;
                //msg += `\nexpected location: ${util.inspect(exp)}`;

                assert.deepEqual(currentToken.location, exp, msg);

                // The old assertions; un-comment for sanity-checking
                const html = htmlChunks.map(chunk => (Array.isArray(chunk) ? chunk.join('') : chunk)).join('');
                const lines = html.split(/\r?\n/g);

                //Offsets
                let actual = html.substring(currentToken.location.startOffset, currentToken.location.endOffset);
                let expected = srcChunk;
                assert.strictEqual(actual, expected);

                //Line/col
                actual = getSubstringByLineCol(lines, currentToken.location);
                expected = normalizeNewLine(srcChunk);
                assert.strictEqual(actual, expected);
            }
        };
    }
}
