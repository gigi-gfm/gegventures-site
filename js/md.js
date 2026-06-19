// Tiny, dependency-free Markdown -> HTML renderer for AI tool output.
// Handles headings, bold/italic, inline code, links, lists, blockquotes,
// fenced code blocks, horizontal rules and GitHub-style tables. Output is
// HTML-escaped first, so it is safe to inject into the page.
window.GegMD = (function () {
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>'
      );
  }

  function splitRow(s) {
    return s
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map(function (c) {
        return c.trim();
      });
  }

  function render(src) {
    var lines = (src || '').replace(/\r\n/g, '\n').split('\n');
    var html = [];
    var i = 0;
    var listType = null; // 'ul' or 'ol'

    function closeList() {
      if (listType) {
        html.push('</' + listType + '>');
        listType = null;
      }
    }

    while (i < lines.length) {
      var line = lines[i];

      // Fenced code block
      if (/^```/.test(line)) {
        closeList();
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(esc(lines[i]));
          i++;
        }
        i++; // skip closing fence
        html.push('<pre class="md-code"><code>' + buf.join('\n') + '</code></pre>');
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) {
        closeList();
        i++;
        continue;
      }

      // Heading
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        var lvl = h[1].length;
        html.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
        closeList();
        html.push('<hr/>');
        i++;
        continue;
      }

      // Table (header row + separator row of dashes)
      if (
        line.indexOf('|') !== -1 &&
        i + 1 < lines.length &&
        /^[\s|:-]+$/.test(lines[i + 1]) &&
        lines[i + 1].indexOf('-') !== -1
      ) {
        closeList();
        var header = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') !== -1 && !/^\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        var t =
          '<table class="md-table"><thead><tr>' +
          header
            .map(function (c) {
              return '<th>' + inline(c) + '</th>';
            })
            .join('') +
          '</tr></thead><tbody>';
        t += rows
          .map(function (r) {
            return (
              '<tr>' +
              r
                .map(function (c) {
                  return '<td>' + inline(c) + '</td>';
                })
                .join('') +
              '</tr>'
            );
          })
          .join('');
        t += '</tbody></table>';
        html.push(t);
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        closeList();
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          q.push(inline(lines[i].replace(/^>\s?/, '')));
          i++;
        }
        html.push('<blockquote>' + q.join('<br/>') + '</blockquote>');
        continue;
      }

      // Ordered list
      var ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        if (listType !== 'ol') {
          closeList();
          html.push('<ol>');
          listType = 'ol';
        }
        html.push('<li>' + inline(ol[1]) + '</li>');
        i++;
        continue;
      }

      // Unordered list
      var ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        if (listType !== 'ul') {
          closeList();
          html.push('<ul>');
          listType = 'ul';
        }
        html.push('<li>' + inline(ul[1]) + '</li>');
        i++;
        continue;
      }

      // Paragraph
      closeList();
      var p = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i])
      ) {
        p.push(inline(lines[i]));
        i++;
      }
      html.push('<p>' + p.join('<br/>') + '</p>');
    }

    closeList();
    return html.join('\n');
  }

  return { render: render };
})();
