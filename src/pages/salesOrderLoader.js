export async function fetchAllSalesOrders({ getOrders, params, pageSize }) {
  const firstResponse = await getOrders({ ...params, limit: pageSize, offset: 0 });
  if (Array.isArray(firstResponse)) return firstResponse;

  const firstPage = firstResponse.orders || [];
  const total = Number(firstResponse.total ?? firstPage.length);
  if (firstPage.length >= total) return firstPage;
  if (firstPage.length === 0) {
    throw new Error(`Incomplete sales order response: expected ${total}, received 0`);
  }

  async function loadSequential(loaded) {
    let offset = loaded.length;
    while (true) {
      const response = await getOrders({ ...params, limit: pageSize, offset });
      const page = Array.isArray(response) ? response : (response.orders || []);
      loaded.push(...page);
      if (page.length === 0 || loaded.length >= total) {
        if (loaded.length >= total) return loaded;
        throw new Error(`Incomplete sales order response: expected ${total}, received ${loaded.length}`);
      }
      offset += page.length;
    }
  }

  if (firstPage.length < Math.min(pageSize, total)) {
    return loadSequential([...firstPage]);
  }

  const offsets = [];
  for (let offset = firstPage.length; offset < total; offset += pageSize) {
    offsets.push(offset);
  }

  const pages = new Array(offsets.length);
  let nextPage = 0;
  async function loadNextPage() {
    while (nextPage < offsets.length) {
      const pageIndex = nextPage;
      nextPage += 1;
      const response = await getOrders({ ...params, limit: pageSize, offset: offsets[pageIndex] });
      pages[pageIndex] = Array.isArray(response) ? response : (response.orders || []);
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, offsets.length) }, loadNextPage));
  const shortPageIndex = pages.findIndex((page, index) => (
    page.length < Math.min(pageSize, total - offsets[index])
  ));
  if (shortPageIndex >= 0) {
    return loadSequential([firstPage, ...pages.slice(0, shortPageIndex + 1)].flat());
  }

  return [firstPage, ...pages].flat();
}

export async function loadSalesOrdersForPerson({ activePerson, getOrders, pageSize }) {
  if (activePerson === '이준형') {
    const [leeOrders, kimOrders] = await Promise.all([
      fetchAllSalesOrders({ getOrders, params: { sales_person: '이준형' }, pageSize }),
      fetchAllSalesOrders({ getOrders, params: { sales_person: '김보수' }, pageSize }),
    ]);
    return [...leeOrders, ...kimOrders];
  }

  return fetchAllSalesOrders({ getOrders, params: { sales_person: activePerson }, pageSize });
}
