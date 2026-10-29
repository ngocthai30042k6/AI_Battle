import React from 'react';

function PythonCode({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-[11px] leading-5 text-[var(--text-primary)]"><code>{children}</code></pre>;
}

export const PYTHON_BOT_DOCS_TITLE = 'Tài liệu cấu trúc tham số game_state cho Python Bot';

export function PythonBotDocs() {
  return (
    <article className="space-y-4 text-xs leading-6 text-[var(--text-secondary)] [&_code]:text-[var(--text-primary)] [&_h3]:font-bold [&_h3]:text-[var(--text-primary)] [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
      <p>Hàm được gọi mỗi lượt và nhận mã người chơi của bạn cùng trạng thái bàn cờ hiện tại. Hãy trả về một nước đi hợp lệ.</p>
      <PythonCode>{`def get_next_move(my_player_id, game_state):
    moves = game_state.get('validMoves', [])
    return moves[0] if moves else None`}</PythonCode>
      <p>
        <code>game_state</code> là dictionary Python. Lấy dữ liệu bằng tên khóa, ví dụ{' '}
        <code>game_state['validMoves']</code>. Dùng <code>game_state.get('validMoves', [])</code>{' '}
        để có danh sách rỗng nếu khóa không tồn tại.
      </p>
      <section className="space-y-2">
        <h3>Bàn cờ và lượt chơi</h3>
        <ul>
          <li><code>board</code>: bàn cờ 9 × 9; ô hàng <code>r</code>, cột <code>c</code> được đọc bằng <code>board[r][c]</code>. Hàng và cột đánh số từ 0 đến 8.</li>
          <li><code>flatBoard</code>: cùng bàn cờ trải thành danh sách 81 ô. Chỉ số ô bằng <code>row * 9 + col</code>; hàng 2, cột 3 là chỉ số 21.</li>
          <li><code>boardRows</code>, <code>boardCols</code>: số hàng và cột (đều là 9). <code>turn</code>: mã người chơi đang đi. <code>myPlayerId</code> và <code>opponentPlayerId</code>: mã của bạn và đối thủ; <code>my_player_id</code> cũng là mã của bạn.</li>
          <li><code>stepCount</code>: số lượt đã đi; <code>noCapturePlies</code>: số lượt liên tiếp chưa có quân bị ăn.</li>
        </ul>
      </section>
      <section className="space-y-2">
        <h3>Danh sách nước đi: <code>validMoves</code></h3>
        <p>Mỗi phần tử là một dictionary mô tả một nước hợp lệ trong lượt này.</p>
        <ul>
          <li><code>fromRow</code>, <code>fromCol</code>: hàng/cột xuất phát; <code>toRow</code>, <code>toCol</code>: hàng/cột đích. Các giá trị nằm trong khoảng 0–8.</li>
          <li><code>from</code>, <code>to</code>: chỉ số ô xuất phát/đích từ 0 đến 80, tính bằng <code>row * 9 + col</code>.</li>
          <li><code>fromAlg</code>, <code>toAlg</code>: tọa độ dạng chữ dễ đọc, ví dụ <code>a1</code>.</li>
          <li><code>isAttack</code> và <code>isCapture</code>: <code>True</code> nếu tấn công/ăn quân, ngược lại <code>False</code>.</li>
          <li><code>pieceType</code>: hệ quân đang đi; <code>targetType</code>: hệ quân ở ô đích hoặc <code>None</code> nếu ô trống. Tên hệ: <code>'rock'</code>, <code>'paper'</code>, <code>'scissors'</code>.</li>
        </ul>
        <p>Ví dụ <code>fromRow=2, fromCol=3, toRow=2, toCol=4</code> nghĩa là quân đi từ ô hàng 2 cột 3 sang hàng 2 cột 4. Chọn một phần tử sẵn có trong <code>validMoves</code> là cách đơn giản để bảo đảm nước đi hợp lệ.</p>
      </section>
      <section className="space-y-2">
        <h3>Quân trên bàn và số lượng</h3>
        <ul>
          <li><code>myPieces</code>, <code>opponentPieces</code>: danh sách quân còn trên bàn của hai bên. Mỗi quân có <code>row</code>, <code>col</code>, <code>index</code>, <code>algebraic</code>, <code>player</code>, <code>type</code>, <code>raw</code>. <code>type</code> là tên hệ; <code>index</code> là chỉ số ô 0–80.</li>
          <li><code>myPieceCounts</code>, <code>opponentPieceCounts</code>: số quân từng hệ còn lại, gồm <code>rock</code>, <code>paper</code>, <code>scissors</code>, <code>total</code>. Nếu một hệ của đối thủ còn 0 quân, bạn đạt điều kiện thắng theo luật.</li>
        </ul>
      </section>
      <section className="space-y-2">
        <h3>Ô đặc biệt và luật</h3>
        <ul>
          <li><code>specialCells</code>: chỉ số các ô <code>a1</code>, <code>i9</code> và các khóa <code>myWinIndex</code>/<code>opponentWinIndex</code> cho biết ô thắng của mỗi bên.</li>
          <li><code>blockedCells</code>: danh sách chỉ số ô bị khóa theo luật giải đấu, ví dụ <code>[30, 31, 32]</code>; có thể rỗng.</li>
          <li><code>rules</code>: thông tin bộ luật đang áp dụng; có thể là <code>None</code>.</li>
        </ul>
      </section>
      <section className="space-y-2">
        <h3>Giá trị trả về và ví dụ</h3>
        <p>Có thể trả dictionary bằng tọa độ hàng/cột:</p>
        <PythonCode>{"return {'fromRow': 2, 'fromCol': 3, 'toRow': 2, 'toCol': 4}"}</PythonCode>
        <p>Hoặc bằng chỉ số ô:</p>
        <PythonCode>{"return {'from': 21, 'to': 22}"}</PythonCode>
        <p>Ví dụ ưu tiên nước ăn quân, nếu không có thì đi nước hợp lệ đầu tiên:</p>
        <PythonCode>{`def get_next_move(my_player_id, game_state):
    moves = game_state.get('validMoves', [])
    if not moves:
        return None
    attacks = [move for move in moves if move['isAttack']]
    return attacks[0] if attacks else moves[0]`}</PythonCode>
        <p>Luôn chọn từ <code>validMoves</code> để tránh trả về nước không hợp lệ.</p>
      </section>
    </article>
  );
}
