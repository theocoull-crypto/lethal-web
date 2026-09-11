function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('LETHAL WEB')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
